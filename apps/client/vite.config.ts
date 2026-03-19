import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { DEFAULT_PORT } from '@dorkos/shared/constants';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    // Ensure React loads development bundles (act, error messages) even when
    // the host shell has NODE_ENV=production.
    env: { NODE_ENV: 'test' },
    setupFiles: ['./src/test-setup.ts'],
    server: {
      // Inline jest-dom so Vitest resolves its transitive deps (redent,
      // @adobe/css-tools, dom-accessibility-api) from the pnpm store
      // rather than requiring them to be hoisted into apps/client/node_modules.
      deps: {
        inline: ['@testing-library/jest-dom'],
      },
    },
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
      // @dorkos/shared/manifest uses Node.js built-ins (fs, path, crypto) and
      // is only consumed by DirectTransport in Electron/Obsidian. Externalize
      // it from the browser bundle to prevent Vite from inlining Node modules.
      external: ['@dorkos/shared/manifest'],
    },
  },
});
