import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Archivo, served from the platform's own assets, with its width and weight axes (OFL-1.1, listed in NOTICE.md).
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/archivo/wdth-italic.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
