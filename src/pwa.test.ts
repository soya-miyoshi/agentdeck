// m4/pwa's done-when, against the REAL build output served by the REAL static handler.
//
// Nothing here is checked against the sources in `src/client`: a manifest that is correct in the
// repository and not copied into `dist/client`, or served with a content type the browser will
// not accept, is not installable, and that is exactly the failure this file exists to catch. So
// it requires `pnpm build` to have run and reads what is on disk in the build directory, through
// `withClient` on a real socket.
//
// What is NOT demonstrated here, and cannot be from this machine: the home-screen install itself.
// See the sentence at the bottom of this file and the README section it points at.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { withClient } from "./static.ts";

const clientDir = fileURLToPath(new URL("../dist/client", import.meta.url));
const built = existsSync(join(clientDir, "index.html"));

let server: Server;
let base = "";

const api = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no route" }));
};

void before(async () => {
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
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

void describe("the manifest, as the server actually serves it", { skip: !built }, () => {
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
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    // Without `viewport-fit=cover` every `env(safe-area-inset-*)` resolves to zero and the whole
    // layout half of this item silently does nothing.
    assert.match(page, /viewport-fit=cover/);
    assert.match(page, /apple-mobile-web-app-capable" content="yes"/);
  });

  void test("every icon it names exists, at the size it claims", async () => {
    const manifest = JSON.parse(
      await (await fetch(`${base}/manifest.webmanifest`)).text(),
    ) as Manifest;
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
    const page = await (await fetch(`${base}/`)).text();
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(page)?.[1];
    assert.ok(href !== undefined, "no apple-touch-icon, which is what iOS puts on the home screen");
    const res = await fetch(new URL(href, base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
  });

  void test("no emoji anywhere in what gets installed", () => {
    const text = readFileSync(join(clientDir, "manifest.webmanifest"), "utf8");
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
  });
});

void describe("the service worker, and what it provably cannot do", { skip: !built }, () => {
  void test("it is served from the root, as JavaScript, so its scope is the whole app", async () => {
    const res = await fetch(`${base}/sw.mjs`);
    assert.equal(res.status, 200);
    // A worker served as anything but a JavaScript type is rejected by `register` outright.
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    // A worker's maximum scope is its own directory, so being at the root IS the scope claim -
    // moved under `/assets/` it could never control `/`, and no header would fix that here
    // because `/assets/` is also served `immutable`.
    const bundle = await (await fetch(`${base}/assets/${assetName(".js")}`)).text();
    assert.match(bundle, /register\(\s*["`']\/sw\.mjs["`']/);
    assert.match(bundle, /scope:\s*["`']\/["`']/);
  });

  void test("it is not cached hard, so a replacement can never be locked out", async () => {
    const cache = (await fetch(`${base}/sw.mjs`)).headers.get("cache-control") ?? "";
    assert.match(cache, /no-cache|no-store|max-age=0/);
    assert.doesNotMatch(cache, /immutable/);
    // The other half of the same property: the browser is told not to consult an HTTP cache for
    // this file at all when it checks for an update.
    const bundle = await (await fetch(`${base}/assets/${assetName(".js")}`)).text();
    assert.match(bundle, /updateViaCache:\s*["`']none["`']/);
  });

  void test("it cannot intercept /api or /ws, or anything else, because it answers nothing", async () => {
    const text = await (await fetch(`${base}/sw.mjs`)).text();
    // The comments in that file argue for all of this at length, and the argument is prose. What
    // is asserted is the CODE, so strip them first rather than let the word "cache" in a sentence
    // decide whether the worker caches.
    const source = text.replace(/\/\/.*$/gm, "");
    // This is the whole safety argument and it is a property of the FILE, not of a route list:
    // a worker with no `respondWith` cannot substitute a response for any request, so there is no
    // path on which it could serve a cached `/api/sessions`, a cached socket handshake, or a
    // stale `index.html`. A route allowlist would have to be got right; this cannot be got wrong.
    assert.doesNotMatch(source, /respondWith/);
    assert.doesNotMatch(source, /\bcaches\b|CacheStorage|cache\.put|cache\.match/);
    // And it takes over immediately rather than sitting a version behind until every tab closes.
    assert.match(source, /skipWaiting/);
    assert.match(source, /clients\.claim/);
  });

  void test("the shell it would have cached is still the server's to invalidate", async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get("cache-control") ?? "", /no-cache|no-store|max-age=0/);
  });
});

void describe("the phone layout, in the built CSS", { skip: !built }, () => {
  void test("the insets are declared and used on the edges that have hardware", async () => {
    const css = await (await fetch(`${base}/assets/${assetName(".css")}`)).text();
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.match(css, new RegExp(`env\\(safe-area-inset-${side}`), `no ${side} inset survived`);
    }
    // The tab strip owns the top edge and the pane area owns the bottom, so the terminal's last
    // rows - the cursor and any prompt - are clear of the home indicator.
    assert.match(css, /--safe-top:[^;]*safe-area-inset-top/);
    assert.match(css, /--safe-bottom:[^;]*safe-area-inset-bottom/);
    assert.match(css, /padding:[^;]*var\(--safe-bottom\)/);
  });

  void test("the touch targets survive the build at 44px or more", async () => {
    const css = await (await fetch(`${base}/assets/${assetName(".css")}`)).text();
    assert.match(css, /--touch-target:\s*44px/);
    // Both surfaces a thumb has to hit before anything else works: the tabs and the paste field.
    const uses = css.match(/min-height:\s*var\(--touch-target\)/g) ?? [];
    assert.ok(uses.length >= 2, `only ${String(uses.length)} control claims a touch target`);
  });
});

/** The hashed asset of a given extension in this build, read from the page rather than guessed. */
let names: string[] | undefined;
function assetName(ext: string): string {
  names ??= [...readFileSync(join(clientDir, "index.html"), "utf8").matchAll(/\/assets\/([^"]+)/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
  const found = names.find((name) => name.endsWith(ext));
  assert.ok(found !== undefined, `the built page names no ${ext} asset`);
  return found;
}

// NOT DEMONSTRATED HERE, and not claimed: the home-screen install. Everything above is checkable
// from the Mac; "it installs to the home screen and launches without browser chrome" needs a
// phone, and the only other tailnet device has been offline for days. The steps a person with a
// phone has to take are written down in the README under "Installing to the home screen".
