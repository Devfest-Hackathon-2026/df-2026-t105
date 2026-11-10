import { defineConfig } from "vite";

export default defineConfig({
  // Worker が初めて basic-pitch を読んだときに Vite が依存を最適化し直してページを再読み込みしないよう、先に含めておく
  optimizeDeps: { include: ["@spotify/basic-pitch", "tone", "@google/genai"] },
  worker: { format: "es" },
  // 中継サーバー（npm run server、:8787）へ流す。SDK は //ws/... のように / を重ねることがあるので正規表現で受ける
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "^/+ws/": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
