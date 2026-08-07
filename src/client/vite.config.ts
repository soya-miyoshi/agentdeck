import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The client's root is this directory, so index.html sits beside the code it loads and the server
// sources one level up stay out of the bundle - they are imported for their types only, which is
// erased before anything reaches here.

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    // Not Vite's default 5173, and that is a credential decision rather than a preference. The
    // token is kept in `localStorage`, which is keyed by ORIGIN - so on the default port every
    // other Vite project on this machine shares an origin with agentdeck, and anything running in
    // one of those pages can read a token that starts sessions in every allowed repository, kills
    // live ones, and attaches to every other agent's terminal.
    port: 7778,
    strictPort: true,
    // Dev only. In production the app and the API are the same origin, which is what the server's
    // Origin check assumes.
    proxy: {
      "/api": { target: "http://127.0.0.1:7777" },
      "/ws": { target: "http://127.0.0.1:7777", ws: true },
    },
  },
});
