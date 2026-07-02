import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import type { InlineConfig } from "vitest";

const testConfig: InlineConfig = {
  environment: "node",
  exclude: ["node_modules", "dist", "src-tauri", "tests/e2e/**"],
};

export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1420,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
  },
  test: testConfig,
} as UserConfig & { test: InlineConfig });
