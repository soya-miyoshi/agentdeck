import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";

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
const isApiPath = (urlPath: string): boolean =>
  urlPath === "/api" || urlPath.startsWith("/api/") || urlPath === "/ws";

const NOT_BUILT = (root: string): string =>
  `agentdeck: the client is not built, so there is no page to serve. ` +
  `Run \`pnpm build\`, which writes ${root}.`;

// What an UNAUTHENTICATED caller is told, which is deliberately less. The sentence above names an
// absolute path, so on the wire it hands out the account name, the checkout layout and the forge
// owner before any token is presented - and this is the state the server is in when it is most
// likely to be probed. `/api/health`, the only other unauthenticated route, was held to liveness
// and a version for the same reason. The instruction still goes to the log, where the person who
// can act on it is.
const NOT_BUILT_PUBLIC = "the client is not built - run `pnpm build`; see the server log\n";

/**
 * On every answer, including the refusals.
 *
 * `frame-ancestors` is the one that matters most: the `Origin` check on the socket (plan 001)
 * stops a foreign page opening a socket, but a foreign page that FRAMES the deck reaches the same
 * place with a correct origin - the framed document is ours, reads the token from `localStorage`,
 * and forwards keystrokes to a live session's stdin. `X-Frame-Options` says the same thing to
 * anything that predates CSP. `default-src 'self'` is the containment for the other direction: the
 * app renders agent-controlled bytes and loads nothing off-origin, so an injection in the terminal
 * renderer has nowhere to send the token. Styles are inline because the terminal renderer writes
 * them at runtime; images and fonts allow `data:` for the same reason.
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

  // The file can go away between `realpath` and `stat` - `pnpm build` empties `dist/client` on
  // every run - and an ENOENT here is the same fact as an ENOENT there: this build has no such
  // file. Answered as a miss rather than allowed to escape as a rejection.
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
      // `pipe` unpipes on a client disconnect but never destroys the source, and an `fs.ReadStream`
      // holds a raw descriptor with no finaliser - so every navigation away mid-load, and every
      // aborted request from anywhere on the tailnet, used to leak one fd until EMFILE. `pipeline`
      // destroys the source when the destination closes or errors.
      pipeline(createReadStream(target), res, (error) => {
        if (error !== null && error !== undefined) {
          console.error(`agentdeck: could not read ${target}:`, error);
          res.end();
        }
      });
    })().catch((error: unknown) => {
      // Nothing supervises this process (plan 001, M4), so an unhandled rejection here is the deck
      // gone until a human is at the Mac. Answered like the API's handler answers: logged, 500 if
      // the response has not started, closed if it has.
      console.error("agentdeck: static request failed:", error);
      if (res.headersSent) res.end();
      else sendText(req, res, 500, { "cache-control": "no-store" }, "internal error\n");
    });
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
    const target = req.url ?? "/";
    const raw = target.split(/[?#]/)[0] ?? "/";
    // `new URL` runs synchronously in the request listener, before any catch of ours: the WHATWG
    // parser reads `//` and `/\` as an authority and throws on the empty host, which with nothing
    // supervising the process is the deck gone. A target the parser refuses is not one of our API
    // routes, so route it as the raw path - `locate` resolves that itself and refuses anything that
    // leaves the build directory.
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
