import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: command === "serve" ? {
      "/auth": {
        target: "http://localhost:8081",
        changeOrigin: true
      },
      "/api": {
        target: "http://localhost:8081",
        changeOrigin: true
      }
    } : undefined
  },
  preview: {
    port: 5174
  },
  resolve: {
    alias: {
      "@": "/src"
    }
  }
}));