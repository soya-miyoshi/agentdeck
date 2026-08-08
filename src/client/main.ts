import "@xterm/xterm/css/xterm.css";
import "./main.css";

import { createApp } from "vue";

import App from "./App.vue";

createApp(App).mount("#app");

// The worker is what makes the page installable; what it does is nothing, on purpose - see
// `public/sw.mjs`. Registered at the root so its scope is the whole app rather than wherever this
// module happens to live, and `updateViaCache: "none"` so the browser revalidates `sw.mjs` itself
// on every check instead of trusting an HTTP cache with the file that decides what the others do.
//
// `navigator.serviceWorker` is absent outside a secure context, which is the state this app is in
// until `m4/tailscale-serve` puts HTTPS in front of it, so its absence is normal and not an error
// to report to anyone.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.mjs", { scope: "/", updateViaCache: "none" });
}
