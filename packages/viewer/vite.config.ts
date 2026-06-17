import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend lives in web/; build output goes to dist-web/ (served by server/index.ts).
// In dev, `vite` serves web/ and proxies /api to the running viewer server on :8080.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist-web', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
});
