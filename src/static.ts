import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";

// The one unauthenticated surface (plan 001): the page must load before a token exists. The lexical
// join AND the real path opened are both checked, because a planted symlink looks like nothing.

/** A `.js` served as `text/plain` does not execute, so this map is load-bearing, not cosmetic. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // Served as anything else, the browser ignores the `<link rel="manifest">` and the page is
  // simply not installable, with nothing in any log to say why.
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const contentTypeFor = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * Vite hashes every filename under `assets/`, so those cache forever - a new build is a new name.
 * `index.html` names the current bundle, so caching it strands a phone on the previous deploy.
 */
const cacheControlFor = (urlPath: string): string =>
  urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";

/** Whether an API or socket route owns this path. Those keep their own answers, including 404. */
const isApiPath = (urlPath: string): boolean =>
  urlPath === "/api" || urlPath.startsWith("/api/") || urlPath === "/ws";

const NOT_BUILT = (root: string): string =>
  `agentdeck: the client is not built, so there is no page to serve. ` +
  `Run \`pnpm build\`, which writes ${root}.`;

// What an UNAUTHENTICATED caller is told, deliberately less: the sentence above names an absolute
// path, which hands out the account name and checkout layout before any token is presented.
const NOT_BUILT_PUBLIC = "the client is not built - run `pnpm build`; see the server log\n";

/**
 * On every answer, including the refusals. `frame-ancestors` matters most: a foreign page that
 * FRAMES the deck passes the Origin check, reads the token and types into a live session.
 */
const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "base-uri 'none'; " +
    "object-src 'none'; " +
    "form-action 'none'; " +
    "frame-ancestors 'none'",
};

/** Every answer this file writes by hand rather than streams is a sentence, so the type is fixed. */
const sendText = (
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...SAFETY_HEADERS,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
};

/**
 * Resolve `urlPath` to a real file inside `root`, or say why not. `outside` is the refusal;
 * `missing` is the ordinary case of a path this build has no file for, which the fallback answers.
 */
const locate = async (
  root: string,
  urlPath: string,
): Promise<{ file: string } | { reason: "outside" | "missing" }> => {
  // Decoded per SEGMENT, and the raw path is the one that arrives - `new URL` would have
  // collapsed `..` before this saw it, which turns a traversal into an innocent-looking miss.
  const segments: string[] = [];
  for (const raw of urlPath.split("/")) {
    if (raw === "" || raw === ".") continue;
    let piece: string;
    try {
      piece = decodeURIComponent(raw);
    } catch {
      // A malformed escape is not a path. Refused rather than guessed at.
      return { reason: "outside" };
    }
    // A null byte truncates a path at the syscall boundary, and an ENCODED separator is a segment
    // lying about how many segments it is. A segment is one name; anything else is refused.
    if (/[\0/\\]/.test(piece)) return { reason: "outside" };
    segments.push(piece);
  }

  // Joined onto the root rather than resolved from `/`, so an absolute-looking request is relative.
  // The containment check below, not this, is what stops `..` climbing out.
  const lexical = resolve(join(root, ...segments));
  if (!contains(root, lexical)) return { reason: "outside" };

  let real: string;
  try {
    // The symlink answer: what `realpath` returns is what `createReadStream` will open, so
    // checking containment on it is checking the file rather than the string that named it.
    real = await realpath(lexical);
  } catch {
    return { reason: "missing" };
  }
  if (!contains(root, real)) return { reason: "outside" };

  // The file can go away between `realpath` and `stat` - `pnpm build` empties the directory - and
  // that ENOENT means the same thing: this build has no such file.
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch {
    return { reason: "missing" };
  }
  if (info.isDirectory()) return { reason: "missing" };
  if (!info.isFile()) return { reason: "outside" };
  return { file: real };
};

/**
 * Whether the request names a concrete file rather than a client route: the history fallback must
 * not answer these, because only a 404 evicts a service worker - a 200 of HTML is an update failure.
 */
const namesAFile = (urlPath: string): boolean => {
  if (urlPath.startsWith("/assets/")) return true;
  const last = urlPath.split(/[/]/).pop() ?? "";
  return extname(last).toLowerCase() in CONTENT_TYPES;
};

/** Containment against an already-real root, so no `..` and no symlink survives it. */
const contains = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The static half of the server: `dist/client` on every path no API or socket route owns. A missing
 * build is not a reason to refuse to start, but it says which command to run rather than 404ing.
 */
const createStaticHandler = (
  rootDir: string,
): ((req: IncomingMessage, res: ServerResponse, urlPath: string) => void) => {
  const configured = resolve(rootDir);
  if (!existsSync(configured)) console.error(NOT_BUILT(configured));

  return (req, res, urlPath) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      sendText(req, res, 405, { allow: "GET, HEAD" }, "method not allowed\n");
      return;
    }

    void (async () => {
      let root: string;
      try {
        root = await realpath(configured);
      } catch {
        console.error(NOT_BUILT(configured));
        sendText(req, res, 503, { "cache-control": "no-store" }, NOT_BUILT_PUBLIC);
        return;
      }

      const found = await locate(root, urlPath);
      if ("reason" in found && found.reason === "outside") {
        // Deliberately not the history fallback: a request that tried to leave the build
        // directory is refused, not answered with the page.
        sendText(req, res, 403, { "cache-control": "no-store" }, "forbidden\n");
        return;
      }

      // History fallback: an unknown path that is not a file is a client route. Where it NAMES a
      // file, answering with HTML would hand the browser a script that is a document.
      const target =
        "file" in found
          ? found.file
          : namesAFile(urlPath)
            ? undefined
            : await locate(root, "/index.html").then((r) => ("file" in r ? r.file : undefined));
      if (target === undefined) {
        sendText(req, res, 404, { "cache-control": "no-store" }, "not found\n");
        return;
      }

      const cache = "file" in found ? cacheControlFor(urlPath) : "no-cache";
      res.writeHead(200, {
        "content-type": contentTypeFor(target),
        "cache-control": cache,
        ...SAFETY_HEADERS,
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      // `pipe` unpipes on a disconnect but never destroys the source, so every aborted request
      // leaked an fd until EMFILE. `pipeline` destroys it when the destination closes.
      pipeline(createReadStream(target), res, (error) => {
        if (error !== null && error !== undefined) {
          console.error(`agentdeck: could not read ${target}:`, error);
          res.end();
        }
      });
    })().catch((error: unknown) => {
      // Nothing supervises this process, so an unhandled rejection is the deck gone until a human
      // is at the Mac: logged, 500 if the response has not started, closed if it has.
      console.error("agentdeck: static request failed:", error);
      if (res.headersSent) res.end();
      else sendText(req, res, 500, { "cache-control": "no-store" }, "internal error\n");
    });
  };
};

/**
 * One listener: API and socket routes to `api`, everything else to the built client. Composed
 * rather than folded in, so `/api/*` keeps its own Origin check and JSON 404.
 */
export const withClient = (
  api: (req: IncomingMessage, res: ServerResponse) => void,
  rootDir: string,
): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const client = createStaticHandler(rootDir);
  return (req, res) => {
    // Routing asks the normalised path; serving asks the RAW one, because `new URL` resolves
    // `/../x` to `/x` before any check of ours sees the traversal the client actually sent.
    const target = req.url ?? "/";
    const raw = target.split(/[?#]/)[0] ?? "/";
    // The WHATWG parser reads `//` as an authority and THROWS on the empty host, synchronously in
    // the request listener. A target it refuses is not an API route, so it is served as raw.
    let pathname: string;
    try {
      pathname = new URL(target, "http://localhost").pathname;
    } catch {
      pathname = raw;
    }
    if (isApiPath(pathname)) {
      api(req, res);
      return;
    }
    client(req, res, raw);
  };
};
