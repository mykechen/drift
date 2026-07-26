import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Neither `.onnx` nor `.bin` is one of Vite's known asset extensions, so the
  // model and the baked glyph outlines would be treated as modules and fail to
  // parse. Declaring them here means an `import ... from "*.onnx?url"` emits
  // the file and returns its hashed URL — which also puts both under Vercel's
  // default immutable caching for fingerprinted output.
  assetsInclude: ["**/*.onnx", "**/*.bin"],

  optimizeDeps: {
    // ONNX Runtime Web ships pre-minified with its WebAssembly glue inlined and
    // referenced through mangled internal names. Running it through Vite's
    // esbuild dependency pre-bundle rewrites those names and the runtime dies
    // on load with a "not a function" from inside its own loader. Excluding it
    // serves the published file untouched, which is what it expects.
    exclude: ["onnxruntime-web"],
  },

  build: {
    // Vite fingerprints everything it emits here, so Vercel caches it
    // immutably by default. `vercel.json` covers the hand-placed files in
    // /public that Vite does not fingerprint.
    assetsDir: "assets",

    rollupOptions: {
      input: {
        // The piece.
        room: resolve(__dirname, "index.html"),
        // Internal tool, built into the deploy but linked from nowhere and
        // excluded in robots.txt. It is here so the shipping model can be
        // exercised on real hardware other than the author's laptop.
        debugProperties: resolve(__dirname, "debug/properties.html"),
        debugGlyphs: resolve(__dirname, "debug/glyphs.html"),
      },
    },
  },
});
