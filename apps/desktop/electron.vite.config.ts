import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';
import { TRAY_IMAGE_FILES } from './src/shared/tray-images';
import { clientDefines } from '../client/vite-define';

const clientRoot = path.resolve(__dirname, '../client');
const sharedSrc = path.resolve(__dirname, '../../packages/shared/src');
const buildResources = path.resolve(__dirname, 'build');

/**
 * Copy the tray images from `build/` into the main process's output directory.
 *
 * `build/` is electron-builder's `buildResources` directory, which is
 * deliberately NOT packaged into the app — and `electron-builder.yml`'s `files`
 * allowlist only ships `dist/**` anyway. Rather than duplicate them into
 * `extraResources` (which that file argues against, with reason), they are
 * emitted alongside the compiled main process, so `src/main/tray.ts` resolves
 * one path — `join(__dirname, name)` — in dev and packaged alike.
 *
 * The file list is shared with the loader (`src/shared/tray-images.ts`) rather
 * than repeated here: adding a platform to one list and not the other would
 * package green and produce an app with no tray.
 */
function emitTrayImages(): Plugin {
  return {
    name: 'dorkos:tray-images',
    generateBundle() {
      for (const fileName of TRAY_IMAGE_FILES) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: fs.readFileSync(path.join(buildResources, fileName)),
        });
      }
    },
  };
}

/**
 * Build alias entries for @dorkos/shared subpath exports.
 *
 * electron-vite runs from apps/desktop/ with root set to apps/client/.
 * In CI, pnpm's strict module isolation prevents Rollup from resolving
 * workspace subpath exports across this directory boundary. We resolve
 * them directly to TypeScript source files instead.
 */
function sharedSubpathAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  const files = fs.readdirSync(sharedSrc).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  for (const file of files) {
    const name = file.replace(/\.ts$/, '');
    aliases[`@dorkos/shared/${name}`] = path.resolve(sharedSrc, file);
  }
  return aliases;
}

export default defineConfig({
  main: {
    plugins: [emitTrayImages()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {
    root: clientRoot,
    // The renderer is the CLIENT's source, built by a second config — so it
    // needs the client's `define` map, not just its `root`. Without it the
    // packaged bundle shipped a bare `__APP_VERSION__`, which threw before
    // React mounted and left every desktop install on a black window
    // (v0.63.0, DOR-1448). `scripts/check-renderer-defines.ts` fails the build
    // if that ever recurs.
    define: clientDefines(),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(clientRoot, 'src'),
        ...sharedSubpathAliases(),
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: path.resolve(clientRoot, 'index.html'),
        // @dorkos/shared/manifest uses Node.js built-ins (fs, path, crypto).
        // It's only imported by DirectTransport (not used in Electron renderer).
        external: ['@dorkos/shared/manifest'],
      },
    },
  },
});
