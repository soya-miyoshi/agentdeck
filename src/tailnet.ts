/**
 * What `tailscale serve` needs, and which of it this machine actually has (plan 006).
 *
 * The phone reaches agentdeck over `tailscale serve --bg <port>` in front of the loopback
 * listener. That command is one line, and every hard part of it is a tailnet setting that is off
 * by default and that the CLI does not report well: with Serve disabled the command prints an
 * enable link and then BLOCKS forever rather than exiting, and with HTTPS certificates disabled
 * there is no certificate for the `ts.net` name at all. Neither is something agentdeck can turn
 * on, and neither is visible from inside the process - so this module reads the one cheap,
 * non-mutating source of truth there is, `tailscale status --json`, and turns what is missing
 * into a sentence naming the admin page.
 *
 * Reporting only. Nothing here runs `tailscale serve`: exposure is decided on the host, in one
 * place, which is the whole reason the server binds loopback (plan 001).
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

/**
 * The two facts, out of `tailscale status --json`.
 *
 * `Self.DNSName` carries a trailing dot (`host.tail0000.ts.net.`) and an origin must not, so it
 * is stripped here rather than at each caller. `CertDomains` is `null` when HTTPS certificates
 * are disabled and lists the machine's names when they are enabled; it is the only field that
 * answers the question without provisioning anything, which `tailscale cert` would.
 */
export const parseTailnetStatus = (raw: unknown): Tailnet => {
  const status = raw as { Self?: { DNSName?: unknown }; CertDomains?: unknown };
  const dnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const name = dnsName.replace(/\.$/, "");
  return {
    origin: name === "" ? undefined : `https://${name}`,
    httpsCertificates: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
  };
};

/**
 * Read it, or report nothing readable.
 *
 * Undefined covers every way this can fail - no `tailscale` on PATH, `tailscaled` not running,
 * logged out, JSON that is not what this version emits. They are one case to the caller: nothing
 * can be said about the tailnet, so nothing is claimed about it. A boot must never depend on
 * this, so the timeout is hard and no failure propagates.
 */
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

/**
 * What to tell the operator, given what was found and how the server is configured.
 *
 * Sentences, in the order a person acts on them: the setting that has to be changed in a browser
 * first, then the command, then the variable. Each names the thing to do rather than the state
 * that is wrong, because the failure this exists to prevent is an opaque one - a URL that does
 * not resolve, or a `tailscale serve` that hangs with no error at all.
 */
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
