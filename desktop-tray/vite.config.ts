import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer lives in ui/. Built assets go to ui/dist and are loaded via
// file:// in production (relative base so file:// URLs resolve).
export default defineConfig({
  root: "ui",
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5201,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});