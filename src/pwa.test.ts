// The REAL build output through the REAL static handler, never the sources: a manifest correct in the
// repository and not copied into the build is not installable. NOT demonstrated: the install.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { withClient } from "./static.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(repoRoot, "dist/client");

let server: Server;
let base = "";

const api = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no route" }));
};

void before(async () => {
  // The build is what is under test, so an absent one is BUILT rather than skipped: gating on
  // `existsSync` turns the one item whose deliverable is build output into a green tick.
  try {
    readFileSync(join(clientDir, "index.html"));
  } catch {
    execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", timeout: 300_000 });
  }

  server = createServer(withClient(api, clientDir));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

void after(() => {
  server.close();
});

/** The width and height an actual PNG declares, read out of its IHDR rather than trusted. */
const pngSize = (file: string): { width: number; height: number } => {
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.subarray(0, 8).equals(signature), `${file} is not a PNG`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

interface Manifest {
  display: string;
  scope: string;
  start_url: string;
  icons: { src: string; sizes: string; type: string }[];
}

/** The hashed asset of a given extension in this build, read from the page rather than guessed. */
let names: string[] | undefined;
const assetName = (ext: string): string => {
  names ??= [...readFileSync(join(clientDir, "index.html"), "utf8").matchAll(/\/assets\/([^"]+)/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
  const found = names.find((name) => name.endsWith(ext));
  assert.ok(found !== undefined, `the built page names no ${ext} asset`);
  return found;
};

/** What the running server actually answers with, which is the only thing this file asserts on. */
const served = async (path: string): Promise<string> =>
  await (await fetch(`${base}${path}`)).text();

/** The built module or stylesheet, fetched the way a browser reaches it. */
const asset = async (ext: string): Promise<string> => await served(`/assets/${assetName(ext)}`);

void describe("the manifest, as the server actually serves it", () => {
  void test("it is served with the type that makes a browser read it, and it parses", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    // Anything else and the `<link rel="manifest">` is ignored, silently, with no log anywhere.
    assert.match(res.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    const manifest = JSON.parse(await res.text()) as Manifest;
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.start_url, "/");
  });

  void test("the page links it, and asks for the viewport the safe-area insets need", async () => {
    const page = await served("/");
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    // Without `viewport-fit=cover` every `env(safe-area-inset-*)` resolves to zero and the whole
    // layout half of this item silently does nothing.
    assert.match(page, /viewport-fit=cover/);
    assert.match(page, /apple-mobile-web-app-capable" content="yes"/);
  });

  void test("every icon it names exists, at the size it claims", async () => {
    const manifest = JSON.parse(await served("/manifest.webmanifest")) as Manifest;
    assert.ok(manifest.icons.length > 0, "a manifest with no icons is not installable");
    for (const icon of manifest.icons) {
      const res = await fetch(new URL(icon.src, base));
      assert.equal(res.status, 200, `${icon.src} is declared and not served`);
      assert.equal(res.headers.get("content-type"), icon.type);
      const [width, height] = icon.sizes.split("x").map(Number);
      const actual = pngSize(join(clientDir, icon.src));
      assert.deepEqual(
        actual,
        { width, height },
        `${icon.src} claims ${icon.sizes} and is ${String(actual.width)}x${String(actual.height)}`,
      );
    }
  });

  void test("the apple-touch-icon the page names is served too", async () => {
    const page = await served("/");
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(page)?.[1];
    assert.ok(href !== undefined, "no apple-touch-icon, which is what iOS puts on the home screen");
    const res = await fetch(new URL(href, base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
  });

  void test("it is not cached hard either, so a changed manifest reaches the phone", async () => {
    // An installed app re-reads the manifest to pick up a new name, icon or display mode. Served
    // `immutable` it would be the manifest of the deploy the phone first saw, permanently.
    const cache = (await fetch(`${base}/manifest.webmanifest`)).headers.get("cache-control") ?? "";
    assert.doesNotMatch(cache, /immutable/);
    assert.match(cache, /no-cache|no-store|max-age=0/);
  });

  void test("the CSP the server sends does not forbid the worker or the manifest", async () => {
    // Both fall back to `default-src 'self'` today, so this asserts a later tightening cannot
    // silently un-install the app - nothing on this machine would notice.
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    for (const directive of ["worker-src", "manifest-src", "child-src"]) {
      const declared = new RegExp(`${directive}([^;]*)`).exec(csp)?.[1];
      if (declared !== undefined) {
        assert.match(declared, /'self'/, `${directive} is declared without 'self'`);
      }
    }
  });

  void test("no emoji anywhere in what gets installed", () => {
    // The manifest is the visible one - its name goes under the home-screen icon - but the page
    // and the worker are installed alongside it and the rule is repository-wide.
    for (const file of ["manifest.webmanifest", "index.html", "sw.mjs"]) {
      const content = readFileSync(join(clientDir, file), "utf8");
      assert.doesNotMatch(content, /\p{Extended_Pictographic}/u, `${file} contains an emoji`);
    }
  });
});

void describe("the service worker, and what it provably cannot do", () => {
  void test("it is served from the root, as JavaScript, so its scope is the whole app", async () => {
    const res = await fetch(`${base}/sw.mjs`);
    assert.equal(res.status, 200);
    // A worker served as anything but a JavaScript type is rejected by `register` outright.
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    // A worker's maximum scope is its own directory, so being at the root IS the scope claim -
    // under `/assets/` it could never control `/`, and that path is served `immutable` besides.
    const bundle = await asset(".js");
    assert.match(bundle, /register\(\s*["`']\/sw\.mjs["`']/);
    assert.match(bundle, /scope:\s*["`']\/["`']/);
  });

  void test("it is not cached hard, so a replacement can never be locked out", async () => {
    const cache = (await fetch(`${base}/sw.mjs`)).headers.get("cache-control") ?? "";
    assert.match(cache, /no-cache|no-store|max-age=0/);
    assert.doesNotMatch(cache, /immutable/);
    // The other half of the same property: the browser is told not to consult an HTTP cache for
    // this file at all when it checks for an update.
    const bundle = await asset(".js");
    assert.match(bundle, /updateViaCache:\s*["`']none["`']/);
  });

  void test("it cannot intercept /api or /ws, or anything else, because it answers nothing", async () => {
    const worker = await served("/sw.mjs");
    // The argument in that file is prose and what is asserted is the CODE, so the comments are
    // stripped rather than letting the word "cache" in a sentence decide anything.
    const source = worker.replace(/\/\/.*$/gm, "");
    // The whole safety argument, as a property of the FILE: a worker with no `respondWith` cannot
    // substitute a response for anything. An allowlist would have to be got right.
    assert.doesNotMatch(source, /respondWith/);
    assert.doesNotMatch(source, /\bcaches\b|CacheStorage|cache\.put|cache\.match/);
    // And it takes over immediately rather than sitting a version behind until every tab closes.
    assert.match(source, /skipWaiting/);
    assert.match(source, /clients\.claim/);
    // The two ways the checks above could be true of this file and false of what actually runs:
    // code pulled in from somewhere else, or a response manufactured here to hand back later.
    assert.doesNotMatch(source, /importScripts|\bimport\s*\(/);
    assert.doesNotMatch(source, /new Response\b/);
  });

  void test("the worker is the whole of it - no second worker is registered anywhere", async () => {
    // `respondWith` being absent from `sw.mjs` only bounds what THAT file does. If the bundle
    // registered a second worker as well, this file's argument would cover none of it.
    const bundle = await asset(".js");
    const registrations = bundle.match(/serviceWorker\s*\.\s*register\s*\(/g) ?? [];
    assert.equal(registrations.length, 1, "exactly one worker is registered, and it is sw.mjs");
  });

  void test("the shell it would have cached is still the server's to invalidate", async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get("cache-control") ?? "", /no-cache|no-store|max-age=0/);
  });

  void test("deleting it from the build 404s, which is what evicts it from the phone", async () => {
    // The kill switch is deleting the file and rebuilding, and it only works if the server then
    // 404s: a 200 of HTML reads as a failed update, and the worker keeps running.
    const root = mkdtempSync(join(tmpdir(), "agentdeck-nosw-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>deck</title>");
    const bare = createServer(withClient(api, root));
    await new Promise<void>((ready) => bare.listen(0, "127.0.0.1", ready));
    try {
      const at = `http://127.0.0.1:${String((bare.address() as AddressInfo).port)}`;
      for (const path of ["/sw.mjs", "/manifest.webmanifest", "/icons/icon-192.png"]) {
        const res = await fetch(`${at}${path}`);
        const body = await res.text();
        assert.equal(res.status, 404, `${path} is absent and was answered ${String(res.status)}`);
        assert.doesNotMatch(body, /<!doctype html>/i, `${path} was answered with the SPA shell`);
      }
      // And a real client route still is the shell, which is the whole point of the fallback.
      const route = await fetch(`${at}/sessions/abc`);
      assert.equal(route.status, 200);
      assert.match(route.headers.get("content-type") ?? "", /text\/html/);
    } finally {
      bare.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

void describe("the phone layout, in the built CSS", () => {
  void test("the insets are declared and used on the edges that have hardware", async () => {
    const css = await asset(".css");
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.match(css, new RegExp(`env\\(safe-area-inset-${side}`), `no ${side} inset survived`);
    }
    // The tab strip owns the top edge and the key row owns the bottom, so the terminal's last rows
    // - the cursor and any prompt - are clear of both the key caps and the home indicator.
    assert.match(css, /--safe-top:[^;]*safe-area-inset-top/);
    assert.match(css, /--safe-bottom:[^;]*safe-area-inset-bottom/);
    assert.match(css, /padding:[^;]*var\(--safe-bottom\)/);
  });

  void test("the touch targets survive the build at 44px or more", async () => {
    const css = await asset(".css");
    assert.match(css, /--touch-target:\s*44px/);
    // Every surface a thumb has to hit: the tabs, the paste field, and the key row's caps - which
    // are the ones pressed under time pressure, with an agent waiting on the answer.
    const uses = css.match(/min-height:\s*var\(--touch-target\)/g) ?? [];
    assert.ok(uses.length >= 3, `only ${String(uses.length)} control claims a touch target`);
  });
});

// NOT DEMONSTRATED, and not claimed: the home-screen install. Everything above is checkable from
// the Mac; launching without browser chrome needs a phone, and the README has the steps.
