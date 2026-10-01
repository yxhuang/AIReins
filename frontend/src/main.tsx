import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./store";
import { applyBodyFontSize, readBodyFontSize } from "./body-font";
import "./styles.css";

applyBodyFontSize(readBodyFontSize());
void store.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
