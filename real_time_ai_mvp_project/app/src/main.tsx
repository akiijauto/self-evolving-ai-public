import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root が見つかりません");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker はオフライン起動のためだけに使う。
// 開発中はキャッシュが邪魔になるため本番ビルドのみ登録する。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service Worker の登録に失敗しました", error);
    });
  });
}
