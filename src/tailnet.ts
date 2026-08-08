/**
 * What `tailscale serve` needs, and which of it this machine actually has (plan 006).
 *
 * Reads `tailscale status --json` - the one cheap, non-mutating source - and turns the two
 * default-off tailnet switches into sentences naming the admin page. Reporting only: nothing here
 * runs `tailscale serve`, because exposure is decided on the host in one place (plan 001).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the CLI actually is, both installers' locations; PATH is never consulted. */
const TAILSCALE_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/** The binary to run: `AGENTDECK_TAILSCALE` if set (the tests set it to a stub), else the first
 *  installed candidate, else undefined - which every caller reports rather than falling back. */
export const tailscaleBinary = (): string | undefined => {
  const named = process.env["AGENTDECK_TAILSCALE"];
  if (named !== undefined && named !== "") return existsSync(named) ? named : undefined;
  return TAILSCALE_CANDIDATES.find((path) => existsSync(path));
};

/** Long enough for a busy `tailscaled`, short enough that a wedged one cannot delay a boot. */
const STATUS_TIMEOUT_MS = 3000;

/** Where both switches live. Named in full because it is the whole point of the report. */
export const ADMIN_DNS_PAGE = "https://login.tailscale.com/admin/dns";

export interface Tailnet {
  /** `https://<magicdns-name>`, or undefined when there is no name to build it from. */
  readonly origin: string | undefined;
  /** False when `CertDomains` is empty: HTTPS certificates are off for this tailnet. */
  readonly httpsCertificates: boolean;
}

/** The two facts, out of `tailscale status --json`: `Self.DNSName` carries a trailing dot an
 *  origin must not, and `CertDomains` is null exactly when HTTPS certificates are off. */
export const parseTailnetStatus = (raw: unknown): Tailnet => {
  const status = raw as { Self?: { DNSName?: unknown }; CertDomains?: unknown };
  const dnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const name = dnsName.replace(/\.$/, "");
  return {
    origin: name === "" ? undefined : `https://${name}`,
    httpsCertificates: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
  };
};

/** Read it, or report nothing readable: undefined covers every failure alike, because a boot must
 *  never depend on this and nothing may be claimed about a tailnet that could not be read. */
export const readTailnet = async (): Promise<Tailnet | undefined> => {
  const binary = tailscaleBinary();
  if (binary === undefined) return undefined;
  try {
    const { stdout } = await run(binary, ["status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
    });
    return parseTailnetStatus(JSON.parse(stdout));
  } catch {
    return undefined;
  }
};

/** What to tell the operator, in the order a person acts on it: the browser switch, then the
 *  command, then the variable. Each names the action, because the failures it prevents are silent. */
export const tailnetAdvice = (
  tailnet: Tailnet | undefined,
  port: number,
  configuredOrigin: string | undefined,
): string[] => {
  if (tailnet === undefined) {
    return [
      "agentdeck: could not read `tailscale status --json`, so nothing here knows whether the " +
        "phone can reach this server. Loopback still works; the ts.net URL needs tailscale " +
        "running and logged in on this Mac.",
    ];
  }

  const lines: string[] = [];
  if (tailnet.origin === undefined) {
    lines.push(
      "agentdeck: tailscale reports no MagicDNS name for this machine, so there is no ts.net " +
        `URL to open. Enable MagicDNS at ${ADMIN_DNS_PAGE}.`,
    );
  }
  if (!tailnet.httpsCertificates) {
    lines.push(
      "agentdeck: HTTPS certificates are DISABLED for this tailnet (`tailscale status --json` " +
        `reports no CertDomains), so \`tailscale serve\` cannot serve the ts.net name over ` +
        `HTTPS and the phone gets no page. Enable HTTPS Certificates at ${ADMIN_DNS_PAGE}. ` +
        "The CLI does not say this: with Serve not enabled for the tailnet it prints an enable " +
        "link and then waits forever instead of exiting, so run it with a timeout.",
    );
  }
  if (tailnet.origin !== undefined) {
    lines.push(
      `agentdeck: to reach this from the phone, run \`tailscale serve --bg ${String(port)}\` on ` +
        `this Mac and open ${tailnet.origin}/.`,
    );
    if (configuredOrigin === undefined) {
      lines.push(
        `agentdeck: behind that proxy the page is same-origin, so AGENTDECK_ORIGIN=${tailnet.origin} ` +
          "is the value that turns the Origin check on. Unset it again for the loopback and Vite " +
          "flows, which are a different origin and would be refused.",
      );
    } else if (configuredOrigin !== tailnet.origin) {
      lines.push(
        `agentdeck: AGENTDECK_ORIGIN is ${configuredOrigin}, which is not this machine's tailnet ` +
          `origin ${tailnet.origin}. A phone loading the ts.net URL will be answered 403 on every ` +
          "/api call and on the socket upgrade.",
      );
    }
  }
  return lines;
};

/**
 * Whether `tailscale serve status` output shows Funnel on, i.e. exposure to the public internet
 * rather than to the tailnet. One definition, because the install script and the watchdog must not
 * disagree about what it looks like.
 */
export const funnelLine = (text: string): string | undefined =>
  text.split("\n").find((line) => /funnel\s+on/i.test(line) || /^\s*Funnel on\b/i.test(line));
