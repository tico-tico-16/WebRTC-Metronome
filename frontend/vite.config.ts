import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: "index.html",
        host: "host/index.html",
        client: "client/index.html",
      },
    },
  },
});
