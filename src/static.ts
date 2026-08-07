import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

// The one unauthenticated surface (plan 001, Authentication): the page has to load before there
// is a token to send, so a bearer check in front of the SPA would make the paste field
// unreachable. What that buys an attacker is bounded by this file being an inert asset server and
// nothing else - it injects nothing into the HTML, and it resolves strictly inside the build
// directory.
//
// Strictly means resolved-and-verified, not string-inspected. On this machine there is no
// boundary between an agent and the home directory, so a path that escapes `dist/client` reads
// ~/.ssh, ~/.agentdeck/token - which starts sessions in every allowed repository - and every
// repo on the allowlist. `..`, `%2e%2e`, an absolute path, a null byte and a decomposed unicode
// spelling all end up as one resolved path, and a SYMLINK planted inside the build output escapes
// without any of those appearing in the request at all. So both the lexical join and the real
// path of what was opened are checked against the real path of the root, and anything outside is
// refused rather than served.

/** A `.js` served as `text/plain` does not execute, so this map is load-bearing, not cosmetic. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
 * Vite writes a content hash into every filename under `assets/`, so those are safe to cache
 * forever - a new build is a new name. `index.html` is not: it is the file that names the current
 * bundle, and caching it hard leaves a phone on the previous deploy until someone clears a
 * browser they cannot reach.
 */
const cacheControlFor = (urlPath: string): string =>
  urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";

/** Whether an API or socket route owns this path. Those keep their own answers, including 404. */
export const isApiPath = (urlPath: string): boolean =>
  urlPath === "/api" || urlPath.startsWith("/api/") || urlPath === "/ws";

const NOT_BUILT = (root: string): string =>
  `agentdeck: the client is not built, so there is no page to serve. ` +
  `Run \`pnpm build\`, which writes ${root}.`;

const send = (
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  headers: Record<string, string>,
  body: string,
): void => {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
};

/**
 * Resolve `urlPath` to a real file inside `root`, or say why not.
 *
 * `outside` is the refusal: the request named something that does not live under the build
 * directory, however it spelled it. `missing` is the ordinary case of a path this build has no
 * file for, which is what the history fallback answers.
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
    // lying about how many segments it is - `%2f`, `%5c` and `%00` are how a single component
    // becomes a path. A segment is one name; anything claiming otherwise does not get resolved.
    if (/[\0/\\]/.test(piece)) return { reason: "outside" };
    segments.push(piece);
  }

  // Joined onto the root rather than resolved from `/`, so an absolute-looking request is a
  // relative one - and it is the containment check, not this, that stops `..` climbing out.
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

  const info = await stat(real);
  if (info.isDirectory()) return { reason: "missing" };
  if (!info.isFile()) return { reason: "outside" };
  return { file: real };
};

/** Containment against an already-real root, so no `..` and no symlink survives it. */
const contains = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The static half of the server: `dist/client` on every path an API or socket route does not own.
 *
 * A missing build is not a reason to refuse to start - the API and the sockets are the part that
 * is holding someone's agents - but it must not present as a silent 404 on every page load
 * either, so it says the sentence that names the command to run, at boot and on every request.
 */
export const createStaticHandler = (
  rootDir: string,
): ((req: IncomingMessage, res: ServerResponse, urlPath: string) => void) => {
  const configured = resolve(rootDir);
  if (!existsSync(configured)) console.error(NOT_BUILT(configured));

  return (req, res, urlPath) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(
        req,
        res,
        405,
        "text/plain; charset=utf-8",
        { allow: "GET, HEAD" },
        "method not allowed\n",
      );
      return;
    }

    void (async () => {
      let root: string;
      try {
        root = await realpath(configured);
      } catch {
        send(
          req,
          res,
          503,
          "text/plain; charset=utf-8",
          { "cache-control": "no-store" },
          `${NOT_BUILT(configured)}\n`,
        );
        return;
      }

      const found = await locate(root, urlPath);
      if ("reason" in found && found.reason === "outside") {
        // Deliberately not the history fallback: a request that tried to leave the build
        // directory is refused, not answered with the page.
        send(
          req,
          res,
          403,
          "text/plain; charset=utf-8",
          { "cache-control": "no-store" },
          "forbidden\n",
        );
        return;
      }

      // History fallback. An unknown path that is not a file is a client route, so the SPA gets
      // to decide what it means - except under `assets/`, where a miss is a genuinely absent
      // build artifact and answering it with HTML would give the browser a script that is a
      // document.
      const target =
        "file" in found
          ? found.file
          : urlPath.startsWith("/assets/")
            ? undefined
            : await locate(root, "/index.html").then((r) => ("file" in r ? r.file : undefined));
      if (target === undefined) {
        send(
          req,
          res,
          404,
          "text/plain; charset=utf-8",
          { "cache-control": "no-store" },
          "not found\n",
        );
        return;
      }

      const cache = "file" in found ? cacheControlFor(urlPath) : "no-cache";
      res.writeHead(200, {
        "content-type": contentTypeFor(target),
        "cache-control": cache,
        "x-content-type-options": "nosniff",
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(target)
        .on("error", (error) => {
          console.error(`agentdeck: could not read ${target}:`, error);
          res.end();
        })
        .pipe(res);
    })();
  };
};

/**
 * One listener: API and socket routes to `api`, everything else to the built client.
 *
 * Composed rather than folded into `createHandler` so that the `Origin` check and the JSON 404 on
 * `/api/*` are untouched by this - a client that asked for JSON and got the HTML page fails in a
 * way nobody can read.
 */
export const withClient = (
  api: (req: IncomingMessage, res: ServerResponse) => void,
  rootDir: string,
): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const client = createStaticHandler(rootDir);
  return (req, res) => {
    // Routing asks the normalised path, because that is the path the API's own routes match on.
    // Serving asks the RAW one: `new URL` resolves `/../x` to `/x` before any check of ours runs,
    // so the traversal the client sent has to reach the static handler as it was written.
    const raw = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
    if (isApiPath(new URL(req.url ?? "/", "http://localhost").pathname)) {
      api(req, res);
      return;
    }
    client(req, res, raw);
  };
};
