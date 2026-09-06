import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "in.gammaterminal.app",
  appName: "GammaTerminal",
  webDir: "dist",
  android: {
    // the backend is currently plain HTTP (http://92.4.84.13); the WebView
    // origin is https://localhost, so those calls are "mixed content".
    // Allow it until the server has a domain + TLS, then this can go.
    allowMixedContent: true,
  },
};

export default config;
