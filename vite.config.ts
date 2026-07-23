import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Every shipped asset is fingerprinted so `_headers` can cache it forever.
    assetsDir: 'assets',
  },
});
