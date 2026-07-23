import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Vite fingerprints everything it emits here, so Vercel caches it
    // immutably by default. `vercel.json` covers the hand-placed files in
    // /public that Vite does not fingerprint.
    assetsDir: "assets",
  },
});
