// The done-when of m4/token-qr, executed against the real server rather than against `qr.ts`.
//
// `src/qr.test.ts` proves the encoder: a string in, the same string decoded back out of the grid
// and out of the rendered lines. It cannot prove the thing the item is actually about, which is
// that the process a person starts on their Mac prints a QR of THE TOKEN IT JUST ISSUED, beside a
// URL that answers - and that it does so on the first run only. Nothing in a unit test would
// notice if `server.ts` printed the QR before `loadToken` (a code for a token that no longer
// exists), printed some other string, printed it on every boot, or printed the token as text
// beside it.
//
// So this file boots the server three times against temp HOMEs, captures stdout, and DECODES what
// it printed - with the decoder in `src/fixtures/qr-decoder.ts`, which shares no code with the
// encoder - then compares it against the bytes in `$HOME/.agentdeck/token`.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawn as spawnPty, type IPty } from "node-pty";

import { decodeLines, qrBlockLines } from "./fixtures/qr-decoder.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(repoRoot, "src", "server.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];
const ptys: IPty[] = [];

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const freePort = async (): Promise<number> =>
  await new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        done(found);
      });
    });
  });

interface Boot {
  stdout: string;
  stderr: string;
  port: number;
}

/**
 * One boot, held until it has listened and then a moment longer.
 *
 * The grace after "listening on" is not slack: the QR is printed AFTER the listen line on purpose,
 * so a test that stopped reading at "listening on" would see no QR on the run that prints one and
 * would pass for the wrong reason on the run that does not.
 */
const boot = async (
  home: string,
  origin?: string,
  options: { tty?: boolean } = {},
): Promise<Boot> => {
  const tty = options.tty ?? true;
  const port = await freePort();
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    TERM: "xterm-256color",
    LC_ALL: "en_US.UTF-8",
    TMUX_SOCKET: `agentdeck-qr-${String(process.pid)}`,
    AGENTDECK_PORT: String(port),
    AGENTDECK_MOUNTS: temp("agentdeck-qr-work-"),
    ...(origin === undefined ? {} : { AGENTDECK_ORIGIN: origin }),
  };
  let stdout = "";
  let stderr = "";
  // A real PTY when the case is about what a person sees, pipes when it is about what a
  // redirected or launchd-supervised run writes. The difference is the whole point of the
  // isTTY gate, so a test that only ever pipes could not tell the two apart.
  //
  // A PTY is one stream for both, so the PTY run sends stderr to a file and reads it back: the
  // boot warnings mention example origins, and merging them into stdout would let a case that
  // asks what the server PRINTED AS ITS URL pass or fail on a warning's wording.
  let child: ChildProcess | undefined;
  let pty: IPty | undefined;
  let errFile: string | undefined;
  const exited = { code: null as number | null, done: false };
  if (tty) {
    errFile = join(temp("agentdeck-qr-err-"), "stderr");
    pty = spawnPty("/bin/sh", ["-c", `exec ${process.execPath} ${serverPath} 2> ${errFile}`], {
      cols: 200,
      rows: 60,
      env,
    });
    ptys.push(pty);
    pty.onData((chunk: string) => {
      stdout += chunk.replaceAll("\r\n", "\n");
    });
    pty.onExit(({ exitCode }) => {
      exited.code = exitCode;
      exited.done = true;
    });
  } else {
    const piped = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    child = piped;
    children.push(piped);
    piped.stdout.setEncoding("utf8");
    piped.stderr.setEncoding("utf8");
    piped.stdout.on("data", (chunk: string) => (stdout += chunk));
    piped.stderr.on("data", (chunk: string) => (stderr += chunk));
    piped.on("exit", (code) => {
      exited.code = code;
      exited.done = true;
    });
  }
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`the server did not listen within 20s\n${stdout}\n${stderr}`));
    }, 20_000);
    timer.unref();
    const poll = setInterval(() => {
      if (exited.done) {
        clearInterval(poll);
        clearTimeout(timer);
        fail(new Error(`the server exited ${String(exited.code)} instead of listening\n${stderr}`));
        return;
      }
      if (!stdout.includes("listening on")) return;
      clearInterval(poll);
      clearTimeout(timer);
      // Everything the boot prints, not just up to the listen line.
      setTimeout(ready, 750);
    }, 50);
  });
  if (pty === undefined) child?.kill("SIGTERM");
  else pty.kill("SIGTERM");
  await new Promise<void>((done) => {
    const give = setTimeout(() => {
      clearInterval(poll);
      done();
    }, 5_000);
    const poll = setInterval(() => {
      if (!exited.done) return;
      clearInterval(poll);
      clearTimeout(give);
      done();
    }, 50);
  });
  if (errFile !== undefined && existsSync(errFile)) stderr = readFileSync(errFile, "utf8");
  return { stdout, stderr, port };
};

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const pty of ptys) {
    try {
      pty.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

void describe("the QR the server prints on first run", () => {
  void test("carries the token it just issued, and the paste field is the fallback beside it", async () => {
    const home = temp("agentdeck-qr-home-");
    const origin = "https://deck.example.ts.net";
    const first = await boot(home, origin);

    const tokenFile = join(home, ".agentdeck", "token");
    assert.ok(existsSync(tokenFile), "the first run issued no token");
    const token = readFileSync(tokenFile, "utf8").trim();
    assert.ok(token.length > 0);

    // Decoded, not eyeballed. This is the whole acceptance criterion: whatever a camera reads off
    // this terminal has to be the credential this process will accept, so the phone gets it
    // without hand-typing 43 random characters.
    const lines = qrBlockLines(first.stdout);
    assert.ok(lines.length > 0, `no QR was printed on the first run\n${first.stdout}`);
    assert.equal(decodeLines(lines), token);

    // Ordered after the listen line, so it is on screen when the person turns to the terminal.
    assert.ok(
      first.stdout.indexOf("listening on") < first.stdout.indexOf(lines[0] ?? ""),
      "the QR was printed before the server listened",
    );

    // The URL is printed beside it as text, and it is the origin the operator configured - not a
    // ts.net hostname this process guessed, and not the loopback address a phone cannot reach.
    assert.ok(first.stdout.includes(origin), "the configured origin was not printed beside the QR");
    assert.ok(first.stdout.includes(tokenFile), "the token file was not named");

    // And the credential is in the code only. A token printed as text beside it lands in the
    // terminal's scrollback, in any capture of it, and in whatever the operator pastes into an
    // issue - which is the leak the file's 0600 mode exists to prevent.
    assert.ok(!first.stdout.includes(token), "the token was printed as text beside the QR");
    assert.ok(!first.stderr.includes(token), "the token was printed to stderr");

    // The fallback the item requires stays: the printed instruction is to paste it into the field,
    // and the field is what the client renders when there is no stored token.
    assert.match(first.stdout, /paste/i);
    const gate = readFileSync(join(repoRoot, "src", "client", "TokenGate.vue"), "utf8");
    assert.match(gate, /aria-label="token"/);
    assert.match(gate, /emit\("token"/);

    // A second boot against the same HOME is not a first run. Reprinting a live credential into
    // the scrollback of every restart is how it ends up in a screen recording; rotation is
    // deleting the file, which the third boot below shows makes it a first run again.
    const second = await boot(home, origin);
    assert.equal(readFileSync(tokenFile, "utf8").trim(), token, "the second boot reissued");
    assert.deepEqual(qrBlockLines(second.stdout), [], "the QR was reprinted on a later boot");
    assert.ok(!second.stdout.includes(token));
    assert.ok(second.stdout.includes("listening on"), "the second boot did not serve");
  });

  void test("with no configured origin, prints the address it is really listening on", async () => {
    // m4/tailscale-serve is not merged and HTTPS is not enabled on this tailnet, so the only URL
    // this process can honestly print is its own. A hardcoded `https://<host>.ts.net` would be a
    // URL that does not answer, which is worse than a loopback one that does.
    const home = temp("agentdeck-qr-home-");
    const run = await boot(home);
    const token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
    assert.equal(decodeLines(qrBlockLines(run.stdout)), token);
    assert.ok(run.stdout.includes(`http://127.0.0.1:${String(run.port)}`));
    assert.ok(!run.stdout.includes("ts.net"), "a tailnet hostname was guessed");
  });

  void test("prints no code at all when stdout is not a terminal", async () => {
    // `pnpm start > ~/agentdeck.log 2>&1 &`, or a launchd agent with a StandardOutPath. The grid
    // IS the token - the decoder three lines below is the proof - so printing it into a file
    // created with the process umask leaves the credential sitting in the operator's home
    // directory, in whatever backs it up, and in the log they later paste into a bug report
    // alongside the boot warnings they meant to report. It does not read as a credential, so
    // nobody redacts it. Nothing is holding a phone up to a log file, so there is nothing lost.
    const home = temp("agentdeck-qr-home-");
    const run = await boot(home, undefined, { tty: false });
    const tokenFile = join(home, ".agentdeck", "token");
    // The token is still issued and still stored: this is about what is printed, not about
    // refusing to run off a terminal.
    assert.ok(existsSync(tokenFile), "the non-TTY first run issued no token");
    const token = readFileSync(tokenFile, "utf8").trim();
    assert.ok(token.length > 0);
    assert.deepEqual(qrBlockLines(run.stdout), [], "the QR was printed to a non-terminal stdout");
    assert.deepEqual(qrBlockLines(run.stderr), []);
    assert.ok(!run.stdout.includes(token), "the token was printed as text");
    assert.ok(!run.stderr.includes(token));
    // And it says enough that the operator is not left guessing where the credential went.
    assert.ok(run.stdout.includes(tokenFile), "the token file was not named");
    assert.match(run.stdout, /terminal/i);

    // The same HOME booted on a real terminal is no longer a first run, so suppressing the code
    // is not deferring it: the way back to one is the documented rotation, deleting the file.
    const again = await boot(home);
    assert.deepEqual(qrBlockLines(again.stdout), [], "a later boot reprinted the QR");
    rmSync(tokenFile);
    const rotated = await boot(home);
    const fresh = readFileSync(tokenFile, "utf8").trim();
    assert.notEqual(fresh, token);
    assert.equal(decodeLines(qrBlockLines(rotated.stdout)), fresh);
  });

  void test("deleting the token file makes the next boot a first run again", async () => {
    // The documented rotation. It is also the only way back to a QR, so if it stopped working the
    // answer to a lost phone would be hand-typing.
    const home = temp("agentdeck-qr-home-");
    const tokenFile = join(home, ".agentdeck", "token");
    const first = await boot(home);
    const original = readFileSync(tokenFile, "utf8").trim();
    rmSync(tokenFile);
    const again = await boot(home);
    const rotated = readFileSync(tokenFile, "utf8").trim();
    assert.notEqual(rotated, original, "the same token came back after rotation");
    assert.equal(decodeLines(qrBlockLines(again.stdout)), rotated);
    assert.notEqual(decodeLines(qrBlockLines(first.stdout)), rotated);
  });
});

void describe("the QR encoder is server-side, and stays out of what the phone downloads", () => {
  void test("no built client asset contains the encoder", () => {
    // The source-level check in src/qr.test.ts is about imports; this is about the artefact. A
    // bundler that inlined it through some other path would leave the source clean and still ship
    // it. `6,34,62,90,118` is the encoder's alignment-pattern table, which survives minification
    // when the identifiers around it do not.
    const clientDir = join(repoRoot, "dist", "client");
    // Built rather than skipped over: a self-skipping test for the one guarantee this check exists
    // to make is a green tick for nothing.
    if (!existsSync(join(clientDir, "index.html")))
      execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", timeout: 300_000 });
    const assets = join(clientDir, "assets");
    const names = readdirSync(assets).filter((name) => name.endsWith(".js"));
    assert.ok(names.length > 0, "the build produced no JavaScript to check");
    for (const name of names) {
      const text = readFileSync(join(assets, name), "utf8").replace(/\s+/g, "");
      assert.ok(!text.includes("qrcode-generator"), `${name} names the QR encoder`);
      assert.ok(!text.includes("6,34,62,90,118"), `${name} carries the QR alignment table`);
    }
  });
});
