import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5176 },
  build: {
    chunkSizeWarningLimit: 1000,
    minify: 'esbuild',       // fastest minifier
    target: 'es2020',        // modern browsers = smaller output
    reportCompressedSize: true,
  }
});
