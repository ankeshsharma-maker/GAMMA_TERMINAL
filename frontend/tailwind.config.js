/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        term: {
          bg: "rgb(var(--term-bg) / <alpha-value>)",
          panel: "rgb(var(--term-panel) / <alpha-value>)",
          panel2: "rgb(var(--term-panel2) / <alpha-value>)",
          border: "rgb(var(--term-border) / <alpha-value>)",
          text: "rgb(var(--term-text) / <alpha-value>)",
          dim: "rgb(var(--term-dim) / <alpha-value>)",
          accent: "rgb(var(--term-accent) / <alpha-value>)",
        },
        up: "#16a34a",
        down: "#dc2626",
        call: "#0e2a1e",
        put: "#2a1414",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", "0.9rem"],
      },
    },
  },
  plugins: [],
};
