import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        host: "host/index.html",
        client: "client/index.html",
      },
    },
  },
});
