import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { decodeGrid, decodeLines, qrBlockLines, readFormat } from "./fixtures/qr-decoder.ts";
import { clientUrl, firstRunLines, qrLines, qrModules } from "./qr.ts";
import { generateToken } from "./token.ts";

// A QR code is verified by decoding it: every interesting bug here produces a square that looks
// perfect and scans as nothing. The decoder is written from the spec, sharing no code with it.

void describe("qr", () => {
  void test("a generated token decodes back out of the grid it was encoded into", () => {
    const token = generateToken();
    assert.equal(decodeGrid(qrModules(token)), token);
  });

  void test("the printed lines decode back, not just the grid behind them", () => {
    // What a phone photographs is the terminal rather than the array, and reading the lines back is
    // what catches a quiet-zone off-by-one or a swapped foreground - neither visible in `qrModules`.
    const token = generateToken();
    const lines = qrBlockLines(
      firstRunLines(token, "http://127.0.0.1:7777", "/tmp/token").join("\n"),
    );
    assert.equal(decodeLines(lines), token);
  });

  void test("decodes tokens from many runs, not one lucky grid", () => {
    // The mask is chosen per code by a penalty search, and the version by length, so a single
    // sample exercises one mask out of eight. Fifty random tokens is enough to see several.
    const seen = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const token = generateToken();
      const grid = qrModules(token);
      seen.add(readFormat(grid).mask);
      assert.equal(decodeGrid(grid), token);
    }
    // The decoder really did have to read the mask: more than one turned up across the sample. If
    // this fails because the encoder fixed its mask, the assumption became safe, not the code broke.
    assert.ok(seen.size > 1, `only mask ${[...seen].join(",")} appeared in fifty codes`);
  });

  void test("the decoder is not a mirror of the encoder: a flipped module breaks it", () => {
    // Against a decoder that shares the encoder's misunderstanding and agrees with it: corrupting one
    // data module must change the output, which it does only if the walk reads the data region.
    const token = generateToken();
    const grid = qrModules(token);
    const last = grid.length - 1;
    (grid[last] as boolean[])[last] = !(grid[last] as boolean[])[last];
    let decoded: string | undefined;
    try {
      decoded = decodeGrid(grid);
    } catch {
      // A flip in the mode indicator makes the stream unreadable rather than merely different.
      decoded = undefined;
    }
    assert.notEqual(decoded, token);
  });

  void test("every character the token alphabet can produce survives the round trip", () => {
    // The dependency's `stringToBytes` is latin-1, so anything above U+00FF is truncated to a
    // different byte and still scans. The claim rests on the token alphabet, so that is what is tested.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    assert.equal(decodeGrid(qrModules(alphabet)), alphabet);
    for (let i = 0; i < 20; i += 1) {
      assert.match(
        generateToken(),
        /^[A-Za-z0-9_-]+$/,
        "the token left the alphabet the latin-1 encoder is safe for",
      );
    }
  });

  void test("a character outside latin-1 would be truncated, which is why none is encoded", () => {
    // The truncation is demonstrated rather than wished about, so the constraint on what may be
    // handed to this encoder is a failing round trip rather than a comment.
    assert.notEqual(decodeGrid(qrModules("é中")), "é中");
  });

  void test("renders half a module row per line, with the quiet zone", () => {
    const text = "x".repeat(43);
    const lines = qrLines(text);
    const width = qrModules(text).length + 8;
    assert.equal(lines.length, Math.ceil(width / 2));
    // One character per module column, each preceded by its own colour escape, and one reset at
    // the end of the line.
    for (const line of lines) {
      assert.equal(line.split("[").length - 1, width + 1);
      assert.ok(line.endsWith("[0m"));
    }
  });

  void test("the code is drawn dark-on-light explicitly, not in the terminal's own colours", () => {
    // An inverted code is the classic "scans on one phone and not another" bug, so both halves of
    // every cell carry an explicit colour and the quiet zone is light.
    const lines = qrLines(generateToken());
    for (const line of lines) {
      for (const cell of line.split("[").slice(1, -1)) {
        const [fg, bg] = (cell.split("m")[0] ?? "").split(";");
        assert.ok(fg === "30" || fg === "97", `foreground ${String(fg)} is not black or white`);
        assert.ok(bg === "40" || bg === "107", `background ${String(bg)} is not black or white`);
      }
    }
    const first = lines[0] ?? "";
    assert.ok(!first.includes("30;40"), "the first quiet-zone line is dark");
  });

  void test("the first-run block prints the URL and the token file beside the code", () => {
    const token = generateToken();
    const lines = firstRunLines(token, "http://127.0.0.1:7777", "/home/x/.agentdeck/token");
    const text = lines.join("\n");
    assert.ok(text.includes("http://127.0.0.1:7777"));
    assert.ok(text.includes("/home/x/.agentdeck/token"));
    // The token is never printed as text: beside the QR it would land in the terminal's scrollback
    // and in any log being captured, which the file's 0600 mode exists to avoid.
    assert.ok(!text.includes(token));
  });

  void test("off a terminal, the block is a sentence and carries no code", () => {
    // The grid is the credential in another encoding, so it must not go anywhere a log goes.
    const token = generateToken();
    const lines = firstRunLines(token, "http://127.0.0.1:7777", "/home/x/.agentdeck/token", false);
    const text = lines.join("\n");
    assert.deepEqual(qrBlockLines(text), [], "a QR was rendered for a non-terminal stdout");
    assert.ok(!text.includes(token), "the token was printed as text instead");
    assert.ok(text.includes("/home/x/.agentdeck/token"), "the token file was not named");
    assert.ok(text.includes("http://127.0.0.1:7777"));
    assert.match(text, /terminal/i);
  });

  void test("the QR carries the bare token, and never a URL with the token in it", () => {
    // A scannable `?token=...` signs a phone in with one tap and writes the credential into history
    // and into every `Referer`. Plan 001 refuses it from a query string; this is the other side.
    const token = generateToken();
    const carried = decodeLines(
      qrBlockLines(firstRunLines(token, "https://deck.example.ts.net", "/tmp/token").join("\n")),
    );
    assert.equal(carried, token);
    assert.ok(!carried.includes("://"), "the QR carries a URL");
    assert.ok(
      !carried.includes("?") && !carried.includes("#"),
      "the QR carries a query or fragment",
    );
  });

  void test("the URL is the configured origin when there is one, and never a guessed ts.net", () => {
    assert.equal(
      clientUrl("https://host.tailXXXXXX.ts.net", 7777),
      "https://host.tailXXXXXX.ts.net",
    );
    assert.equal(clientUrl(undefined, 7777), "http://127.0.0.1:7777");
    // The hostname of a tailnet this process may not be on is not derivable from here, and
    // m4/tailscale-serve has not put anything in front of the port yet.
    assert.ok(!clientUrl(undefined, 7777).includes("ts.net"));
  });

  void test("no ts.net host is hardcoded anywhere in the source", () => {
    // The URL printed has to be one the operator can actually open, and a `.ts.net` literal would
    // keep naming this Mac's hostname on every other machine.
    const source = readFileSync(join(import.meta.dirname, "qr.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    assert.ok(!code.includes("ts.net"), "src/qr.ts hardcodes a tailnet hostname");
  });

  void test("the encoder stays out of the browser bundle", async () => {
    // It is a server-side need: the QR goes to a terminal. Pulling it into the client would spend
    // the sixth dependency on bytes the phone downloads and never runs.
    const dir = join(import.meta.dirname, "client");
    const files = await readdir(dir, { recursive: true });
    for (const file of files) {
      if (!/\.(ts|vue)$/.test(file)) continue;
      const source = readFileSync(join(dir, file), "utf8");
      assert.ok(
        !source.includes("qrcode-generator") && !source.includes("./qr.ts"),
        `${file} imports the QR encoder, which is server-side only`,
      );
    }
  });

  void test("the encoder has no transitive dependencies", () => {
    // The sixth dependency is allowed on condition it can be READ, and a package with a tree behind
    // it spends the budget more than once, quietly. Optional and peer dependencies count.
    const root = join(import.meta.dirname, "..");
    const pkg = JSON.parse(
      readFileSync(join(root, "node_modules", "qrcode-generator", "package.json"), "utf8"),
    ) as {
      version: string;
      license?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), []);
    assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), []);
    assert.equal(pkg.version, "2.0.4");
    assert.equal(pkg.license, "MIT");

    // The lockfile is the second witness, and the one that would catch a dependency arriving in a
    // later version: pnpm writes the resolved graph, and this package's snapshot entry is empty.
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    assert.match(lock, /\n {2}qrcode-generator@2\.0\.4: \{\}\n/);
  });

  void test("it is declared as a runtime dependency, which is what the budget counts", () => {
    // The ceiling belongs to toolchain.test.ts; what is this file's to say is that the encoder is on
    // the RUNTIME side of the manifest and so counted there at all.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.ok(Object.keys(pkg.dependencies).includes("qrcode-generator"));
  });
});
