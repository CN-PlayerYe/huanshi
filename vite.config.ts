import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "desktop",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
    },
  },
  build: {
    outDir: "../dist-renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
