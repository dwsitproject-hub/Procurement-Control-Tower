import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env['VITE_API_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy reproduces the single-origin layout locally, so cookie behaviour in
    // development matches production instead of differing in exactly the way
    // that hides authentication bugs.
    //
    // VITE_API_TARGET overrides the port. The docker pct-api holds 3000 and is
    // SHARED between sessions and worktrees, so verifying a backend change used
    // to mean stopping everyone else's API or rebuilding its image; with this,
    // an API run straight from source on a spare port can be pointed at
    // instead.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/auth': { target: API_TARGET, changeOrigin: false },
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
