import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
);

// https://vitejs.dev/config/
//
// Two targets from one codebase:
//   vite build              → dist/     — bundled by Tauri (frontendDist)
//   vite build --mode web   → dist-web/ — served by the pad GUI container
//
// See src/lib/platform.js for how the target maps to capabilities.
export default defineConfig(async ({ mode }) => ({
  plugins: [vue()],

  // Fallback version for the About modal in the plain web build, where the
  // Tauri app API (which reads tauri.conf.json) is unavailable.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_TARGET__: JSON.stringify(mode === "web" ? "web" : "desktop"),
  },

  build: {
    // Kept separate so a web build never overwrites the directory Tauri bundles.
    outDir: mode === "web" ? "dist-web" : "dist",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
