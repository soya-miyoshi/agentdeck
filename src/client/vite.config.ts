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
    // Dev only. In production the app and the API are the same origin, which is what the server's
    // Origin check assumes.
    proxy: {
      "/api": { target: "http://127.0.0.1:7777" },
      "/ws": { target: "http://127.0.0.1:7777", ws: true },
    },
  },
});
