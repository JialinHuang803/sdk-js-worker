import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), ["VITE_", "ACTIVITY_PORT"]);
  const localAuth = command === "serve" && !isPreview && env.VITE_ACTIVITY_AUTH === "github";
  const activityPort = env.ACTIVITY_PORT?.trim() || "8787";
  if (localAuth && (!/^\d+$/.test(activityPort) || Number(activityPort) < 1024 || Number(activityPort) > 65535)) {
    throw new Error("ACTIVITY_PORT must be an integer from 1024 to 65535.");
  }
  if (env.VITE_ACTIVITY_AUTH === "entra" &&
    (env.VITE_ACTIVITY_API_URL !== "/api" || env.VITE_BASE_PATH !== "/")) {
    throw new Error("Entra hosting requires VITE_ACTIVITY_API_URL=/api and VITE_BASE_PATH=/.");
  }
  return {
    base: env.VITE_BASE_PATH?.trim() || "/sdk-js-worker/",
    plugins: [react()],
    server: {
      fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**", "**/*.pem"] },
      ...(localAuth ? {
        host: "127.0.0.1", port: 5173, strictPort: true,
        proxy: { "/api": { target: `http://127.0.0.1:${Number(activityPort)}`, changeOrigin: false } },
      } : {}),
    },
  };
});
