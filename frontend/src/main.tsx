import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, applyUiZoom } from "./lib/theme";
import { Capacitor } from "@capacitor/core";

// Phone app: its screens ship inside the APK, so no service worker. An older APK registered one,
// and it survives an app update -- it kept serving the PREVIOUS version's screens after users
// installed a new APK. Remove it and its caches, then reload once so the new screens load.
if (Capacitor.isNativePlatform() && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(async (regs) => {
    if (!regs.length) return;
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    if ("caches" in window) {
      const keys = await caches.keys().catch(() => [] as string[]);
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
    location.reload();
  }, () => {});
}

applyTheme(); // accent + background from the user's saved settings
applyUiZoom(); // desktop interface scale
addEventListener("resize", () => applyUiZoom()); // re-check the desktop/mobile boundary

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
