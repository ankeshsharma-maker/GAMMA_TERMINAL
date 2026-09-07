/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        term: {
          bg: "#080b11",
          panel: "#151c28",
          panel2: "#0e1520",
          border: "#1a2331",
          text: "#c8d3e0",
          dim: "#7a8699",
          accent: "#3b82f6",
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
