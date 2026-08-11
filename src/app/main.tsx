import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("缺少应用挂载节点 #root。");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 仅在生产构建注册，避免开发缓存干扰热更新。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {
        // PWA 注册失败不阻断实时网页使用。
      });
  });
}
