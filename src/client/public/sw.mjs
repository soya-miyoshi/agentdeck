// The service worker, and it caches nothing. That is the decision, not an omission.
//
// agentdeck is a live view of processes running on another machine. Everything it is worth
// showing arrives over `/ws` or a fresh `/api` call, and every one of those carries the bearer
// token from `localStorage`. A cache in front of that is a cache of authenticated responses and
// of a session list that was true a minute ago - a screen that looks exactly like a live one and
// is not. This tool exists because a stale answer about what an agent is doing is worse than no
// answer, so the worker that would produce one is not shipped.
//
// The app shell is the tempting exception and it is refused too. Caching `index.html` means the
// phone keeps loading the bundle names of the deploy it first saw; the server deliberately serves
// `index.html` with `no-cache` for exactly that reason (`src/static.ts`), and a worker that
// cached it would be undoing that from inside the browser, on the one device nobody can open a
// devtools window on. An offline shell would also be a terminal with no server behind it: a page
// that renders and can do nothing, which is the confidently-wrong output this design refuses.
//
// So there is no `caches` use here, no `respondWith` anywhere, and therefore no request this
// worker can answer from anything but the network. `/api` and `/ws` are not special-cased,
// because there is no code path that could treat them specially - nothing is intercepted at all.
//
// `.mjs` rather than `.js`, and `globalThis` rather than `self`: the repository lints every `.js`
// file with the type-aware rules, which have no TypeScript project to check a file in `public/`
// against, and the extension is not something the browser reads anyway - a service worker is
// identified by the JavaScript content type the server sends for it (`src/static.ts` maps both).

// A registered worker that is one version behind is the stale shell in another form, so a new
// worker takes over immediately rather than waiting for every tab to close.
globalThis.addEventListener("install", () => {
  globalThis.skipWaiting();
});

globalThis.addEventListener("activate", (event) => {
  event.waitUntil(globalThis.clients.claim());
});

// Present, and deliberately inert. A `fetch` listener that never calls `respondWith` leaves the
// browser to make the request itself, which is what an installability check looks for without
// putting this file in the path of a single byte.
globalThis.addEventListener("fetch", () => {});
