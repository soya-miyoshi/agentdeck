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
/** Extra probes after the first, for the certificate issuance that only happens once. */
const CERT_ATTEMPTS = Number(process.env.AGENTDECK_CERT_ATTEMPTS) || 3;

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
 *  failure being checked for. `ok` requires agentdeck's own /api/health body, not just a 2xx:
 *  any other process holding the port would otherwise pass this gate. */
const probe = async (url) => {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), TOOL_TIMEOUT_MS).unref();
  });
  try {
    const response = await Promise.race([fetch(url), timeout]);
    if (response === "timeout") return { ok: false, detail: `no answer in ${TOOL_TIMEOUT_MS}ms` };
    if (!response.ok) return { ok: false, detail: `HTTP ${String(response.status)}` };
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, detail: "answered 200 but not with JSON, so it is not agentdeck" };
    }
    const agentdeck =
      typeof body === "object" &&
      body !== null &&
      body.ok === true &&
      typeof body.version === "string";
    if (!agentdeck)
      return { ok: false, detail: "answered 200 but not with agentdeck's /api/health body" };
    return { ok: true, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
};

/** The `serve status` line that says Funnel is on, if any. Funnel and serve share one config on
 *  :443, so a serve handler installed under an AllowFunnel node is public, not tailnet-only. */
const funnelLine = (text) =>
  text.split("\n").find((line) => /funnel\s+on/i.test(line) || /^\s*Funnel on\b/i.test(line));

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

const before = await runTool(binary, ["serve", "status"], TOOL_TIMEOUT_MS);
// An unreadable `serve status` is not "Funnel is off": the funnel gate would fail open and put a
// public handler on a node with AllowFunnel set.
if (before.killed || before.code !== 0) {
  say(
    `\`tailscale serve status\` ${before.killed ? "did not exit" : "failed"}, so whether Funnel is ` +
      `on for this node cannot be read: ${before.text.trim()}`,
  );
  say("NOT running `tailscale serve --bg`: nothing was exposed.");
  process.exit(1);
}
const funnelBefore = funnelLine(before.text);
if (funnelBefore !== undefined) {
  say(
    `Funnel is ON for this node, so a serve handler here would be PUBLIC: ${funnelBefore.trim()}`,
  );
  say(`NOT running \`tailscale serve --bg\`. Turn it off first: tailscale funnel ${port} off`);
  process.exit(1);
}

// Before serve, not after: applying the proxy in front of a port this server does not own would
// publish whatever binds it next, and every exit below here would still leave that live.
const local = await probe(`http://127.0.0.1:${port}/api/health`);
if (!local.ok) {
  say(
    `the agentdeck server is not answering on 127.0.0.1:${port} (${local.detail}). Start it first.`,
  );
  say("NOT running `tailscale serve --bg`: nothing was exposed.");
  process.exit(1);
}

say(`putting tailscale serve in front of 127.0.0.1:${port}`);
const serve = await runTool(binary, ["serve", "--bg", port], SERVE_TIMEOUT_MS);

/** Exit non-zero after serve has been run, reporting what `serve status` says is live now rather
 *  than assuming the failed run left nothing behind. */
const exitExposed = async (message) => {
  say(message);
  const now = await runTool(binary, ["serve", "status"], TOOL_TIMEOUT_MS);
  say(`\`tailscale serve status\` now reports:\n${now.text.trim()}`);
  say(`if that is exposing a port you did not mean to expose, undo it with: tailscale serve reset`);
  process.exit(1);
};

if (serve.killed) {
  say(serve.text.trim() === "" ? "(it printed nothing before it blocked)" : serve.text.trim());
  await exitExposed(
    `\`tailscale serve --bg ${port}\` did not exit within ${String(SERVE_TIMEOUT_MS)}ms and was ` +
      "killed. That is Serve not being enabled for this tailnet: it is waiting for the enable " +
      "link above to be clicked.",
  );
}
if (serve.code !== 0)
  await exitExposed(`\`tailscale serve --bg ${port}\` failed: ${serve.text.trim()}`);

const configured = await runTool(binary, ["serve", "status"], TOOL_TIMEOUT_MS);
if (configured.killed || configured.code !== 0)
  await exitExposed(
    `serve was applied but \`tailscale serve status\` ${configured.killed ? "did not exit" : "failed"}, ` +
      `so neither Funnel nor the proxy target can be confirmed: ${configured.text.trim()}`,
  );
const funnelAfter = funnelLine(configured.text);
if (funnelAfter !== undefined)
  await exitExposed(
    `Funnel is ON, so this proxy is reachable from the public internet: ${funnelAfter.trim()}. ` +
      `Turn it off with: tailscale funnel ${port} off`,
  );
if (
  !configured.text.includes(`127.0.0.1:${port}`) &&
  !configured.text.includes(`localhost:${port}`)
)
  await exitExposed(
    `\`tailscale serve status\` does not mention port ${port}:\n${configured.text.trim()}`,
  );
say(`tailscale serve status proxies to 127.0.0.1:${port}`);

// Retried, because the FIRST request to a ts.net name is where tailscaled fetches the
// certificate, and that outruns a single probe budget. Measured on this machine: the first
// attempt timed out at 10s and the next answered in 0.4s.
let remote = await probe(`${tailnet.origin}/api/health`);
for (let attempt = 1; !remote.ok && attempt <= CERT_ATTEMPTS; attempt++) {
  say(
    `no answer yet - the first request is where the certificate is issued (${attempt}/${CERT_ATTEMPTS})`,
  );
  remote = await probe(`${tailnet.origin}/api/health`);
}
if (!remote.ok)
  await exitExposed(
    `serve is configured but ${tailnet.origin}/api/health did not answer (${remote.detail}).`,
  );

say(`${tailnet.origin}/ is up. Open it on the phone.`);
say(`run the server as: AGENTDECK_ORIGIN=${tailnet.origin} pnpm start`);
