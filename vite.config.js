import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4180",
        changeOrigin: true,
      },
    },
  },
  // `vite preview` serves the real production bundle, which is what performance work has to be
  // measured against — dev-mode React overstates render cost several-fold.
  preview: {
    port: 4173,
    proxy: {
      "/api": {
        target: "http://localhost:4180",
        changeOrigin: true,
      },
    },
  },
});
