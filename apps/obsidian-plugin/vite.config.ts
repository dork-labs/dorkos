import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';
import { builtinModules } from 'module';
import { copyManifest } from './build-plugins/copy-manifest.js';
import { fixDirnamePolyfill } from './build-plugins/fix-dirname-polyfill.js';
import { safeRequires } from './build-plugins/safe-requires.js';
import { patchElectronCompat } from './build-plugins/patch-electron-compat.js';

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// apps/server/src/lib/version.ts declares `__CLI_VERSION__` as an
// esbuild-style define, expecting whichever bundler embeds the server
// to inject it (mirrors packages/cli/scripts/build.ts, which defines it
// from the CLI's own package.json version). Vite doesn't know about this
// convention, so without it `SERVER_VERSION` falls back to reading a
// `../../package.json` two directories up from the running file — a path
// that only exists in an unbundled node_modules layout. This plugin
// inlines everything into one `main.js`, so that fallback throws ENOENT
// at module-evaluation time (before onload() runs). Inject the plugin's
// own manifest version, matching what a user actually has installed.
const pluginVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf-8')) as {
    version: string;
  }
).version;

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify(pluginVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    copyManifest(),
    safeRequires(),
    fixDirnamePolyfill(),
    patchElectronCompat(),
  ],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...nodeBuiltins,
      ],
      output: {
        inlineDynamicImports: true,
        exports: 'default',
        assetFileNames: 'styles.[ext]',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: 'inline',
    cssCodeSplit: false,
    target: 'node18',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../client/src'),
    },
  },
});
