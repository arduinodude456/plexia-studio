import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, appRoot, "");
  return {
    root: appRoot,
    base: env.VITE_BASE_PATH || "/",
    plugins: [react(), tsconfigPaths({ projects: [`${appRoot}tsconfig.app.json`] })],
    server: { host: "0.0.0.0", port: 3000, strictPort: true },
    preview: { host: "0.0.0.0", port: 3000, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
});
