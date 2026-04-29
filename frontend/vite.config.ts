import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Dockview ships both CJS and ESM; without dedupe, Vite's pre-bundler can pull in a
  // second React copy via the CJS path, triggering "Invalid hook call" warnings.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8000', ws: true },
      '/api': { target: 'http://localhost:8000' },
    },
  },
  worker: {
    format: 'es',
  },
});
