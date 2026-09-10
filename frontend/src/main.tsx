import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, applyUiZoom } from "./lib/theme";

applyTheme(); // accent + background from the user's saved settings
applyUiZoom(); // desktop interface scale
addEventListener("resize", () => applyUiZoom()); // re-check the desktop/mobile boundary

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
