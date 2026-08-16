import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The client's root is this directory, so index.html sits beside the code it loads and the server
// sources stay out of the bundle - they are imported for their types, which erase.

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    // Not Vite's default 5173, and that is a credential decision: `localStorage` is keyed by ORIGIN,
    // so on the shared port every other Vite project can read the token that starts sessions.
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
