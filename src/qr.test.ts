import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { decodeGrid, decodeLines, qrBlockLines, readFormat } from "./fixtures/qr-decoder.ts";
import { clientUrl, firstRunLines, qrLines, qrModules } from "./qr.ts";
import { generateToken } from "./token.ts";

// A QR code is verified by decoding it, not by looking at it. Eyeballing the blocks confirms that
// something square was printed; it says nothing about whether a phone can read it, and every
// interesting bug in this area - a mask applied twice, a transposed grid, a missing quiet zone,
// an off-by-one in the zig-zag walk - produces a square that looks perfect and scans as nothing.
//
// The decoder lives in `src/fixtures/qr-decoder.ts`, written from the spec rather than from the
// encoder, sharing no code with it and doing no error correction.

void describe("qr", () => {
  void test("a generated token decodes back out of the grid it was encoded into", () => {
    const token = generateToken();
    assert.equal(decodeGrid(qrModules(token)), token);
  });

  void test("the printed lines decode back, not just the grid behind them", () => {
    // What a phone photographs is the terminal, not the array. This reads the rendered lines back
    // the way a camera would and decodes those, which is the check that catches an off-by-one in
    // the quiet zone or a swapped foreground and background - both of which leave `qrModules`
    // perfectly correct.
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
    // And the decoder really did have to read the mask rather than assume one: more than one turned
    // up across the sample. If this ever fails because the encoder fixed its mask, the decoder is
    // still correct - it is the assumption that would have become safe, not the code that broke.
    assert.ok(seen.size > 1, `only mask ${[...seen].join(",")} appeared in fifty codes`);
  });

  void test("the decoder is not a mirror of the encoder: a flipped module breaks it", () => {
    // Guards against the failure mode where a decoder written alongside an encoder shares the
    // same misunderstanding and agrees with it. Corrupting one data module must change what comes
    // out - which it does only if the walk is genuinely reading the data region.
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
    // Reading the dependency turned up that its `stringToBytes` is `charCodeAt(i) & 0xff` - latin-1,
    // not UTF-8 - so any character above U+00FF is silently truncated to a different byte and the
    // code still scans, as something else. The claim that this cannot bite rests entirely on the
    // token alphabet, so the alphabet is what is tested: every base64url character at once, and
    // then the generator itself held to that alphabet.
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
    // Not a wish: the truncation is demonstrated, so that the constraint on what may be handed to
    // this encoder is written down as a failing round trip rather than as a comment. If a future
    // caller passes a URL with a non-ASCII host, this is the behaviour it will get.
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
    // An inverted code is the classic "scans on one phone and not another" bug: blocks drawn in
    // the default foreground of a dark theme produce light-on-dark, which many scanners refuse.
    // So both halves of every cell carry an explicit colour, and the quiet zone is light.
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
    // The token itself is never printed as text. Printing it beside the QR would put the
    // credential in the terminal's own scrollback and in any log the operator is capturing, which
    // is the thing the file's 0600 mode exists to avoid.
    assert.ok(!text.includes(token));
  });

  void test("the QR carries the bare token, and never a URL with the token in it", () => {
    // The decision the item asks to be argued, held as a test rather than only as a comment. A
    // scannable `https://host/?token=...` signs a phone in with one tap and writes the credential
    // into browser history, into the `Referer` of every request the page makes, and into the log
    // of anything in front of the server; a fragment avoids the wire and still lands in history.
    // Plan 001 already refuses the token from a query string, so encoding one here would be
    // defeating that rule from the other side.
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
    // The URL printed today has to be the one the operator can actually open. HTTPS is not on this
    // tailnet and `m4/tailscale-serve` is not merged, so a `.ts.net` literal reaching the printed
    // line would be a URL that does not answer - and would keep answering wrongly after the serve
    // item lands on some other hostname.
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
    // Plan 003 allows the sixth dependency on the condition that it is one that can be read. A
    // package that arrives with a tree behind it spends the budget more than once, and it would do
    // so quietly - nothing else in this repo would notice. Optional and peer dependencies count:
    // both install by default with pnpm's defaults for the peer case, and both are code that ships.
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
    // The ceiling itself belongs to `src/toolchain.test.ts`, which owns the guardrail for every
    // package rather than for this one. What is this file's to say is that the encoder is on the
    // runtime side of the manifest and so is counted there at all - a QR encoder that had landed
    // in `devDependencies` would ship to nobody and be checked by nothing.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.ok(Object.keys(pkg.dependencies).includes("qrcode-generator"));
  });
});
