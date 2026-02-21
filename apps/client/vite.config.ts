import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { DEFAULT_PORT } from '@dorkos/shared/constants';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**'],
    },
  },
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT) || 4241,
    allowedHosts: ['.ngrok-free.app'],
    ...(process.env.TUNNEL_ENABLED === 'true' && { hmr: { clientPort: 443 } }),
    watch: {
      ignored: ['**/state/**'],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.DORKOS_PORT || DEFAULT_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
    },
  },
});
