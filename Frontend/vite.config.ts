import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy reproduces the single-origin layout locally, so cookie behaviour in
    // development matches production instead of differing in exactly the way
    // that hides authentication bugs.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // All libraries are bundled from node_modules — there is no CDN origin,
        // which is what allows the strict CSP with no 'unsafe-inline'.
        manualChunks: { charts: ['chart.js'], vendor: ['react', 'react-dom'] },
      },
    },
  },
});
