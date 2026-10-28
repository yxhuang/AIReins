import { getLocale } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./store";
import { applyBodyFontSize, readBodyFontSize } from "./body-font";
import { initializeHostConnections, workbenchWindowTitle } from "./host-connections";
import "./styles.css";

// 按需模块加载失败由各面板错误边界恢复；禁止自动刷新丢失文件草稿和未发送附件。

// iOS 弹键盘不缩 100dvh，而是平移可视视口，输入框下面会剩一截空白：
// 手机键盘打开时把 .app 钉到可视视口（styles.css 的 html[data-keyboard]）；双指缩放时不跟。
const viewport = window.visualViewport;
if (viewport) {
  const narrow = window.matchMedia("(max-width: 720px)");
  const syncKeyboardViewport = () => {
    const root = document.documentElement;
    if (narrow.matches && Math.abs(viewport.scale - 1) < 0.01 && window.innerHeight - viewport.height > 120) {
      root.dataset.keyboard = "";
      root.style.setProperty("--keyboard-vv-top", `${viewport.offsetTop}px`);
      root.style.setProperty("--keyboard-vv-height", `${viewport.height}px`);
    } else if ("keyboard" in root.dataset) {
      delete root.dataset.keyboard;
    }
  };
  viewport.addEventListener("resize", syncKeyboardViewport);
  viewport.addEventListener("scroll", syncKeyboardViewport);
}

document.documentElement.lang = getLocale();
applyBodyFontSize(readBodyFontSize());
initializeHostConnections();
document.title = workbenchWindowTitle(window.location.href, 0);
void store.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
