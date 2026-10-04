import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies the API to the daemon. The daemon checks Host and Origin, so the proxy
// presents itself as the daemon's own origin. Production builds are served by the daemon itself.
const DAEMON = process.env.ROCKY_DAEMON_URL ?? "http://127.0.0.1:7337";
const proxy = { target: DAEMON, changeOrigin: true, headers: { origin: DAEMON } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": proxy, "/auth": proxy } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
