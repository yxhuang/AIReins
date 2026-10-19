import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 前端源码与构建产物都在 frontend/ 下；依赖解析走仓库根的 node_modules。
// 不引入 @vitejs/plugin-react：esbuild 的 automatic JSX 已够本 MVP 使用（HMR 退化为整页刷新）。
const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: frontendRoot,
  esbuild: { jsx: "automatic" },
  build: {
    // 后端静态目录就是 frontend/dist（server/index.ts 的 STATIC_ROOT 默认值）。
    outDir: "dist",
    // 已打开的页面可能仍引用旧 hash，构建时保留旧资源。
    emptyOutDir: false,
    // 清理脚本据此追踪当前入口的静态/动态 chunk、CSS 与资源。
    manifest: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8790",
      "/pages": "http://127.0.0.1:8790",
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
    },
  },
});
