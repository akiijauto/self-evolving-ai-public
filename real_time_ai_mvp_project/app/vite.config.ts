import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** 開発時に PWA から叩く Gateway Server */
const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  define: {
    // 画面の「使い方」に出すビルド時刻。表示は端末のタイムゾーンで行う。
    // サーバーを更新しても端末に古いアプリが残る事故を、画面だけで切り分けるため
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    // 実機(スマートフォン)から検証するため LAN に公開する。
    // getUserMedia は localhost 以外では HTTPS が必須なため、
    // 実機確認時は トンネル or 自己署名証明書を使う(app/README.md 参照)。
    host: true,
    port: 5173,
    // PWA と Gateway Server を同一オリジンに見せる。
    // CORS と、WebSocket の混在オリジン問題を避けられる。
    proxy: {
      "/api": { target: GATEWAY, changeOrigin: true },
      "/healthz": { target: GATEWAY, changeOrigin: true },
      // 生成MVPの配信。本番はPWAと同一オリジンなので、開発時だけ寄せる
      "/preview": { target: GATEWAY, changeOrigin: true },
      "/ws": { target: GATEWAY, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
