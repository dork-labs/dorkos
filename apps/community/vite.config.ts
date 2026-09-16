import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/browser',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: Number(process.env.COMMUNITY_VITE_PORT ?? 6482),
    strictPort: true,
    proxy: { '/api': `http://localhost:${Number(process.env.COMMUNITY_PORT ?? 6481)}` },
  },
});
