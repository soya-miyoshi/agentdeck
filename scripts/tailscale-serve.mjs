// m4/tailscale-serve: the ONE command the operator runs to put `tailscale serve --bg <port>` in
// front of the loopback listener and prove the phone can reach it. Never `tailscale funnel`.
//
// Why it refuses before it runs anything, and why every shell-out is timed out, is in plan 006:
// with Serve disabled `tailscale serve --bg` prints an enable link and then never exits.

import { execFile } from "node:child_process";
import { ADMIN_DNS_PAGE, parseTailnetStatus, tailscaleBinary } from "../src/tailnet.ts";

const port = process.env.AGENTDECK_PORT ?? "7777";
// Generous: `serve --bg` returns in well under a second when Serve is enabled, and this bound is
// only ever reached by the hang.
const SERVE_TIMEOUT_MS = Number(process.env.AGENTDECK_SERVE_TIMEOUT_MS) || 15_000;
const TOOL_TIMEOUT_MS = 10_000;

const say = (message) => {
  console.log(`agentdeck: ${message}`);
};

/** Every shell-out here, timed out and never throwing: a timeout is the answer this script is
 *  most interested in, not an error. `killed` is how a hang is told from a plain failure. */
const runTool = (binary, args, timeout) =>
  new Promise((resolve) => {
    execFile(binary, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : (error.code ?? 1),
        killed: error !== null && error.killed === true,
        stdout,
        text: `${stdout}${stderr}`,
      });
    });
  });

/** The refusals that must happen BEFORE `serve --bg` is run, because running it in these states is
 *  the hang. Returns the sentences to print, empty when both switches are on. */
const preflight = (tailnet) => {
  if (tailnet === undefined)
    return [
      "could not read `tailscale status --json`. Is tailscaled running and this Mac logged in?",
    ];
  const problems = [];
  if (tailnet.origin === undefined)
    problems.push(
      `tailscale reports no MagicDNS name for this machine. Enable MagicDNS at ${ADMIN_DNS_PAGE}.`,
    );
  if (!tailnet.httpsCertificates)
    problems.push(
      "HTTPS certificates are DISABLED for this tailnet (`tailscale status --json` reports no " +
        `CertDomains), so there is no certificate for the ts.net name. Enable HTTPS Certificates ` +
        `at ${ADMIN_DNS_PAGE}.`,
    );
  return problems;
};

/** A GET with its own timeout, because a proxy that accepts and never answers is exactly the
 *  failure being checked for. */
const probe = async (url) => {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), TOOL_TIMEOUT_MS).unref();
  });
  try {
    const response = await Promise.race([fetch(url), timeout]);
    if (response === "timeout") return { ok: false, detail: `no answer in ${TOOL_TIMEOUT_MS}ms` };
    return { ok: response.ok, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
};

const binary = tailscaleBinary();
if (binary === undefined) {
  say("no tailscale binary found. Set AGENTDECK_TAILSCALE to its absolute path.");
  process.exit(1);
}

const status = await runTool(binary, ["status", "--json"], TOOL_TIMEOUT_MS);
let tailnet;
try {
  tailnet = parseTailnetStatus(JSON.parse(status.stdout));
} catch {
  tailnet = undefined;
}

const problems = preflight(tailnet);
if (problems.length > 0) {
  for (const problem of problems) say(problem);
  say(
    "NOT running `tailscale serve --bg`: with these off it prints an enable link and then blocks " +
      "forever instead of failing. Flip the switches above and run this again.",
  );
  process.exit(1);
}

say(`putting tailscale serve in front of 127.0.0.1:${port}`);
const serve = await runTool(binary, ["serve", "--bg", port], SERVE_TIMEOUT_MS);
if (serve.killed) {
  say(
    `\`tailscale serve --bg ${port}\` did not exit within ${String(SERVE_TIMEOUT_MS)}ms and was ` +
      "killed. That is Serve not being enabled for this tailnet: it is waiting for the enable " +
      "link below to be clicked. Nothing was left running.",
  );
  say(serve.text.trim() === "" ? "(it printed nothing before it blocked)" : serve.text.trim());
  process.exit(1);
}
if (serve.code !== 0) {
  say(`\`tailscale serve --bg ${port}\` failed: ${serve.text.trim()}`);
  process.exit(1);
}

const configured = await runTool(binary, ["serve", "status"], TOOL_TIMEOUT_MS);
if (
  !configured.text.includes(`127.0.0.1:${port}`) &&
  !configured.text.includes(`localhost:${port}`)
) {
  say(`\`tailscale serve status\` does not mention port ${port}:\n${configured.text.trim()}`);
  process.exit(1);
}
say(`tailscale serve status proxies to 127.0.0.1:${port}`);

// Loopback first, so "the server is not running" is never reported as "the proxy is broken".
const local = await probe(`http://127.0.0.1:${port}/api/health`);
if (!local.ok) {
  say(
    `the agentdeck server is not answering on 127.0.0.1:${port} (${local.detail}). Start it first.`,
  );
  process.exit(1);
}

const remote = await probe(`${tailnet.origin}/api/health`);
if (!remote.ok) {
  say(`serve is configured but ${tailnet.origin}/api/health did not answer (${remote.detail}).`);
  process.exit(1);
}

say(`${tailnet.origin}/ is up. Open it on the phone.`);
say(`run the server as: AGENTDECK_ORIGIN=${tailnet.origin} pnpm start`);
