import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBase = env.VITE_API_BASE_URL || "http://localhost:8001";

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 3000,
      strictPort: true,
      watch: {
        usePolling: true,
        interval: 300,
      },
      proxy: {
        "/api": {
          target: apiBase,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
