import "@xterm/xterm/css/xterm.css";
import "./main.css";

import { createApp } from "vue";

import App from "./App.vue";

createApp(App).mount("#app");

// The worker makes the page installable and does nothing else, on purpose. Registered at the root
// for scope, with `updateViaCache: "none"`; absent outside a secure context, which is not an error.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.mjs", { scope: "/", updateViaCache: "none" });
}
