/** @type {import('tailwindcss').Config} */
export default {
  content: ["index.html", "src/**/*.{js,ts,jsx,tsx,html,css}"],
  theme: {
    extend: {
      colors: {
        canvas: "#fafaf9",
        paper: "#ffffff",
        band: "#f0efee",
        soft: "#f5f5f4",
        hairline: "#e7e5e4",
        softline: "#d6d3d1",
        ink: "#0c0a09",
        body: "#44403c",
        muted: "#78716c",
        placeholder: "#a8a29e",
        brand: "#2b69f6",
        "brand-hover": "#2a54ec",
        "brand-wash": "#eff5fe",
      },
      fontFamily: {
        display: ["'Source Serif 4'", "Georgia", "'Times New Roman'", "serif"],
        body: ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "inset 0 0.5px 0 rgba(255,255,255,0.06), 0 8px 20px -4px rgba(0,0,0,0.08), 0 20px 40px -10px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [],
};
