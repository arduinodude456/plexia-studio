import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./components/EditorThemeReset.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Studio root element #root fehlt.");

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
