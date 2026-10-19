import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The space's own website (server-merge step 7e): a second, separate build beside the app's.
 * Its source is `src/space/`, and it still builds into `apps/community/dist/`, the folder the
 * space server and its image serve from, until the image builds from the server package (7f).
 * It shares nothing with the app's build: the space is its own site, on its own origin, under
 * its own content security policy, and none of it ships in the CLI or the desktop app.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL('./src/space/', import.meta.url)),
  publicDir: false,
  cacheDir: fileURLToPath(new URL('./node_modules/.vite-space/', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../community/dist/', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.COMMUNITY_VITE_PORT ?? 6482),
    strictPort: true,
    // '/api/', not '/api': the bare prefix also catches Vite's own request for `api.ts`.
    proxy: { '/api/': `http://localhost:${Number(process.env.COMMUNITY_PORT ?? 6481)}` },
  },
});
