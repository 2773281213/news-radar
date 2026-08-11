import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const LEGACY_ENTRY_JS = "assets/index-B2Eg34rp.js";
const LEGACY_ENTRY_CSS = "assets/index-b0lJDpbs.css";

function legacyEntryAliases(): Plugin {
  return {
    name: "news-radar-legacy-entry-aliases",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (output) => output.type === "chunk" && output.isEntry && output.fileName.endsWith(".js"),
      );
      const stylesheet = Object.values(bundle).find(
        (output) => output.type === "asset"
          && output.fileName.startsWith("assets/index-")
          && output.fileName.endsWith(".css"),
      );
      if (!entry || !stylesheet) {
        this.error("无法定位当前入口 JS/CSS，不能生成旧 Service Worker 兼容别名");
      }
      if (bundle[LEGACY_ENTRY_JS] || bundle[LEGACY_ENTRY_CSS]) {
        this.error("旧 Service Worker 兼容别名与当前构建产物冲突");
      }

      this.emitFile({ type: "asset", fileName: LEGACY_ENTRY_JS, source: entry.code });
      this.emitFile({ type: "asset", fileName: LEGACY_ENTRY_CSS, source: stylesheet.source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), legacyEntryAliases()],
  build: {
    outDir: "dist/client",
    sourcemap: false,
    rollupOptions: {
      output: {
        // 手动拆分 vendor，利于长缓存
        manualChunks: {
          vendor: ["react", "react-dom", "wouter"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
