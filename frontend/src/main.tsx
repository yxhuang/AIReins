import { getLocale } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./store";
import { applyBodyFontSize, readBodyFontSize } from "./body-font";
import { initializeHostConnections, workbenchWindowTitle } from "./host-connections";
import "./styles.css";

// 重新 build 后旧页面按需加载的 chunk（如 TerminalPanel）已不存在，import 失败会让整页白屏/黑屏：
// 自动刷新一次换到新版本；10 秒内再失败就不刷新，免得循环。
window.addEventListener("vite:preloadError", (event) => {
  const key = "wb-chunk-reload-at";
  try {
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 10_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch { return; } // 记不住刷新时间就不冒循环刷新的险
  event.preventDefault();
  location.reload();
});

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
