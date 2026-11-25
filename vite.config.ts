import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/lcd-testnet": {
        target: "https://api-testnet.qore.host",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lcd-testnet/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
