import { defineConfig } from "vite";

export default defineConfig({
  // Worker が初めて basic-pitch を読んだときに Vite が依存を最適化し直してページを再読み込みしないよう、先に含めておく
  optimizeDeps: { include: ["@spotify/basic-pitch", "tone", "@google/genai"] },
  worker: { format: "es" },
});
