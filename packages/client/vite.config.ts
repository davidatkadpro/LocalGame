import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the WebSocket to the game server so a single machine
// can run both with hot reload. In production the game server serves the
// built client and the WS lives on the same origin (no proxy needed).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on LAN for dev testing across devices
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
