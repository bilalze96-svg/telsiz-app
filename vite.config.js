import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // The Firebase browser SDK bundle is about 722 KB minified and 183 KB gzip.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@firebase/") || id.includes("/node_modules/firebase/")) return "firebase";
        }
      }
    }
  }
});
