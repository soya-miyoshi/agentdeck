// The PWA on an emulated iPhone, driven through every flow, with a screenshot and measured checks
// per step. Read by .claude/agents/ui-reviewer.md; run by hand as
//   pnpm build && node scripts/ui-review.mjs [--out <dir>] [--device "iPhone 15"]
// It boots its own server (Go, built from this checkout) on its own port, HOME and tmux socket.

/* global window, document, getComputedStyle -- page.evaluate callbacks run in the browser. */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, devices } from "playwright-core";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = arg("--out", join(tmpdir(), `agentdeck-ui-review-${String(Date.now())}`));
const deviceName = arg("--device", "iPhone 15");
const device = devices[deviceName];
if (device === undefined) throw new Error(`playwright-core has no device named ${deviceName}`);
mkdirSync(out, { recursive: true });

if (!existsSync(join(repo, "dist", "client", "index.html"))) {
  throw new Error(
    "dist/client is not built: run `pnpm build` first, so the review is of this code",
  );
}

// ---- an isolated server with realistic sessions

const work = realpathSync(mkdtempSync(join(tmpdir(), "agentdeck-ui-")));
const home = join(work, "home");
const root = join(work, "roots");
const repos = ["agentdeck", "a-much-longer-repository-name", "api"].map((name) =>
  join(root, "github.com", "someone", name),
);
for (const dir of [home, ...repos]) mkdirSync(dir, { recursive: true });
for (const dir of repos) mkdirSync(join(dir, ".git"));
const profiles = join(work, "agents.json");
writeFileSync(
  profiles,
  JSON.stringify({
    claude: {
      command: "/bin/sh",
      name: "Claude Code",
      waiting: { via: "hook", settings: "c.json" },
    },
    shell: { command: "/bin/sh", name: "Shell" },
  }),
);

const freePort = async () =>
  await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const port = await freePort();
const socket = `agentdeck-uireview-${String(process.pid)}`;
const binary = join(work, "agentdeck");
execFileSync("go", ["build", "-o", binary, "."], { cwd: join(repo, "server-go") });
const server = spawn(binary, [], {
  env: {
    PATH: process.env.PATH,
    HOME: home,
    TERM: "xterm-256color",
    LC_ALL: "en_US.UTF-8",
    TMUX_SOCKET: socket,
    AGENTDECK_REPO: repo,
    AGENTDECK_PORT: String(port),
    AGENTDECK_ROOTS: root,
    AGENTDECK_PROFILES: profiles,
    AGENTDECK_TOKEN_FILE: join(home, "token"),
    AGENTDECK_AGENT_STATE_DIR: join(home, "state"),
    AGENTDECK_REAP_INTERVAL_MS: "0",
    AGENTDECK_TAILSCALE: join(work, "no-tailscale"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 100 && !serverLog.includes("listening on"); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
const base = `http://127.0.0.1:${String(port)}`;
const token = execFileSync("cat", [join(home, "token")], { encoding: "utf8" }).trim();
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await res.json();
};
const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

const created = [];
for (const [cwd, agent] of [
  [repos[0], "claude"],
  [repos[1], "shell"],
  [repos[2], "claude"],
]) {
  created.push((await api("POST", "/api/sessions", { cwd, agent })).session);
}
// Output a real agent session has: scrollback, a wide line, colour, and a prompt waiting on a key.
const fill = [
  'for i in $(seq 1 200); do echo "line $i of earlier output, long enough to wrap at fifty columns"; done',
  "printf '\\033[32m✔ tests passed\\033[0m  \\033[33mwarning: something\\033[0m\\n'",
  "echo 'https://example.com/a/very/long/url/that/someone/wants/to/copy?with=query&and=more'",
  "printf 'Allow this command? [y/n] '",
];
for (const line of fill) tmux("send-keys", "-t", `=${created[0].id}:`, line, "Enter");
tmux("send-keys", "-t", `=${created[1].id}:`, "ls -la /; echo done", "Enter");
await new Promise((r) => setTimeout(r, 1500));

// ---- the browser

const browser = await chromium.launch();
const context = await browser.newContext({ ...device, baseURL: base });
await context.addInitScript((value) => {
  window.localStorage.setItem("agentdeck.token", value);
  // Every frame the page sends, by type, so a send storm is a number rather than a banner.
  window.__sent = {};
  const send = window.WebSocket.prototype.send;
  window.WebSocket.prototype.send = function (raw) {
    try {
      const type = JSON.parse(raw).t;
      window.__sent[type] = (window.__sent[type] ?? 0) + 1;
    } catch {
      // Not JSON: counted as nothing, sent as is.
    }
    return send.call(this, raw);
  };
}, token);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const steps = [];
let n = 0;

/** Measured facts about the page right now: what a person could tap, read, or not reach. */
const measure = async () =>
  await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const label = (el) =>
      (el.getAttribute("aria-label") || el.textContent || el.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    const controls = [
      ...document.querySelectorAll("button, a, input, select, textarea, [role=button]"),
    ]
      .filter(visible)
      .filter((el) => !el.closest(".xterm"));
    const small = controls
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 44 || r.height < 44)
      .map(({ el, r }) => `${label(el)} (${Math.round(r.width)}x${Math.round(r.height)})`);
    const offscreen = controls
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1)
      .map(({ el, r }) => `${label(el)} at x=${Math.round(r.left)} y=${Math.round(r.top)}`);
    const tinyText = [...document.querySelectorAll("body *")]
      .filter((el) => !el.closest(".xterm") && el.childNodes.length > 0)
      .filter((el) =>
        [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim() !== ""),
      )
      .filter(visible)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
      .map((el) => `${label(el)} (${getComputedStyle(el).fontSize})`);
    const shown = ".pane-wrap:not([style*='display: none']) .pane";
    const rows = document.querySelector(`${shown} .xterm-rows`);
    const pane = document.querySelector(shown);
    const paneBox = pane?.getBoundingClientRect();
    return {
      viewport: `${String(vw)}x${String(vh)}`,
      pageScrollsSideways: document.documentElement.scrollWidth > vw,
      undersizedControls: small,
      controlsOutsideViewport: offscreen,
      textUnder12px: [...new Set(tinyText)].slice(0, 15),
      terminalFontPx: rows ? parseFloat(getComputedStyle(rows).fontSize) : null,
      terminalRows: rows ? rows.children.length : null,
      terminalHeightPx: paneBox ? Math.round(paneBox.height) : null,
      // The demo's history is numbered, so a gap in the numbers on screen is lost output.
      historyGaps: (() => {
        const seen = [...(rows?.innerText ?? "").matchAll(/line (\d+) of/g)].map((m) =>
          Number(m[1]),
        );
        return seen.filter((v, i) => i > 0 && v !== (seen[i - 1] ?? 0) + 1).length;
      })(),
      terminalText: rows
        ? rows.innerText
            .split("\n")
            .filter((l) => l.trim() !== "")
            .slice(-6)
        : [],
      paneTouchAction: pane ? getComputedStyle(pane).touchAction : null,
      paneUserSelect: pane ? getComputedStyle(pane).userSelect : null,
      selection: String(window.getSelection() ?? ""),
      tabs: [...document.querySelectorAll(".tab")].map((t) =>
        t.innerText.replace(/\s+/g, " ").trim(),
      ),
      banners: [...document.querySelectorAll(".banner")].map((b) => b.innerText.trim()),
      framesSent: (() => {
        const counts = { ...window.__sent };
        window.__sent = {};
        return counts;
      })(),
      focused: document.activeElement ? label(document.activeElement) : null,
    };
  });

const step = async (name, note, action) => {
  n += 1;
  let error;
  try {
    if (action) await action();
  } catch (e) {
    error = String(e?.message ?? e).split("\n")[0];
  }
  await page.waitForTimeout(400);
  const file = `${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(out, file) });
  steps.push({ step: n, name, note, screenshot: file, error, ...(await measure()) });
};

/** A one-finger drag through the touch pipeline iOS uses, not a mouse wheel. */
const touchDrag = async (x, fromY, toY) => {
  const cdp = await context.newCDPSession(page);
  const point = (y) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(fromY) });
  for (let i = 1; i <= 12; i++) {
    const y = fromY + ((toY - fromY) * i) / 12;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(y) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

/** A long press where iOS would start a text selection. */
const longPress = async (x, y) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

const tapText = async (text) =>
  await page.getByRole("button", { name: text, exact: false }).first().tap();
const openSessions = async () => await page.getByRole("button", { name: "Sessions" }).tap();
const openMore = async () => await page.getByRole("button", { name: "More", exact: true }).tap();
const paneCenter = async () => {
  const box = await page.locator(".pane-wrap:visible .pane").first().boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

await page.goto("/");
await page.waitForSelector(".tab", { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(1500);

await step("first-load", "The app as it opens, with three sessions and the first one active.");
await step("switch-tab", "Tap the second tab.", async () => {
  await openSessions();
  await page.locator(".tab .pick").nth(1).tap();
});
await step("switch-back", "Tap the first tab again; its screen should be intact.", async () => {
  // The session with 200 lines of history, so the scroll steps below have something to scroll.
  await openSessions();
  await page.locator(".tab .pick", { hasText: /^\s*agentdeck/ }).tap();
});
await step("scroll-up", "Drag down on the terminal to read earlier output.", async () => {
  const { x, box } = await paneCenter();
  await touchDrag(x, box.y + 40, box.y + box.height - 40);
});
await step("scroll-down", "Drag up to return to the bottom.", async () => {
  const { x, box } = await paneCenter();
  for (let i = 0; i < 4; i++) await touchDrag(x, box.y + box.height - 40, box.y + 40);
});
await step(
  "long-press-select",
  "Long-press on the URL line, where iOS would begin a selection.",
  async () => {
    const { x, y } = await paneCenter();
    await longPress(x, y);
  },
);
await step(
  "select-open",
  "Tap Select: the screen and recent history as selectable text.",
  async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await tapText("Select");
  },
);
await step(
  "select-text",
  "Select the URL line inside the select view, as a long-press would.",
  async () => {
    // Chromium has no iOS long-press selection, so the selection is made the way the platform would
    // leave it; what this proves is that the view's text is selectable at all.
    await page.evaluate(() => {
      const pre = document.querySelector(".select pre");
      const node = pre?.firstChild;
      const text = node?.textContent ?? "";
      const at = 0;
      if (node === undefined || node === null || at < 0) return;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, Math.max(1, text.indexOf("\n", at)));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  },
);
await step("select-done", "Tap Done to return to the terminal.", async () => {
  await tapText("Done");
});
await step("composer-focus", "Tap the composer to type.", async () => {
  await page.locator("textarea, input[type=text]").last().tap();
});
await step("composer-type", "Type a command and send it.", async () => {
  await page.keyboard.type("echo hello from the phone");
  await tapText("Send");
});
await step(
  "keyboard-open",
  "Simulate the soft keyboard (viewport shrinks by 336px, as on an iPhone 15) with the composer focused.",
  async () => {
    const { width, height } = page.viewportSize();
    await page.setViewportSize({ width, height: height - 336 });
    await page.locator("textarea, input[type=text]").last().focus();
  },
);
await step("keyboard-closed", "Keyboard dismissed: back to the full viewport.", async () => {
  await page.setViewportSize(device.viewport);
});
await step("key-row-esc", "Tap Esc on the key row.", async () => {
  await tapText("Esc");
});
await step("new-session-open", "Open the session list, then New session.", async () => {
  await openSessions();
  await tapText("New session");
});
await step(
  "new-session-close",
  "Close the picker with Cancel, without starting anything.",
  async () => {
    await tapText("Cancel");
  },
);
await step(
  "panels-exclusive",
  "Open the picker, then More: only one panel should show.",
  async () => {
    await openSessions();
    await tapText("New session");
    await openMore();
  },
);
await step("processes-open", "Open Processes from More.", async () => {
  await tapText("Processes");
});
await step("processes-close-own", "Close Processes with its own Close button.", async () => {
  await page.locator(".processes").getByRole("button", { name: "Close" }).tap();
});
await step("login-open", "Open the Login helper from More.", async () => {
  await openMore();
  await tapText("Login");
});
await step("login-close", "Close the Login helper.", async () => {
  const close = page.getByRole("button", { name: /close|done|×/i });
  if ((await close.count()) > 0) await close.first().tap();
  else await tapText("Login");
});
await step(
  "end-disarms",
  "Open the list, arm End on the active session, then wait: it should disarm.",
  async () => {
    await openSessions();
    await page.locator(".tab.active .close").tap();
    await page.waitForTimeout(3500);
  },
);
await step("close-arm", "Tap End on the active tab once (arms it).", async () => {
  await page.locator(".tab.active .close").tap();
});
await step("close-confirm", "Tap again to confirm.", async () => {
  await page.locator(".tab.active .close").tap();
});
await step("landscape", "Rotate to landscape.", async () => {
  const { width, height } = device.viewport;
  await page.setViewportSize({ width: height, height: width });
});

const report = { device: deviceName, out, consoleErrors, steps };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));

await browser.close();
server.kill("SIGTERM");
try {
  const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
  tmux("kill-server");
  if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
} catch {
  // Already gone.
}
rmSync(work, { recursive: true, force: true });

console.log(
  `ui-review: ${String(steps.length)} steps, ${String(consoleErrors.length)} console errors`,
);
console.log(`ui-review: screenshots and report.json in ${out}`);
