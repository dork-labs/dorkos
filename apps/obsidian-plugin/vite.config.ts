import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { builtinModules } from 'module';
import { copyManifest } from './build-plugins/copy-manifest.js';
import { fixDirnamePolyfill } from './build-plugins/fix-dirname-polyfill.js';
import { safeRequires } from './build-plugins/safe-requires.js';
import { patchElectronCompat } from './build-plugins/patch-electron-compat.js';

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  plugins: [react(), tailwindcss(), copyManifest(), safeRequires(), fixDirnamePolyfill(), patchElectronCompat()],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'obsidian', 'electron',
        '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
        '@codemirror/language', '@codemirror/lint', '@codemirror/search',
        '@codemirror/state', '@codemirror/view',
        '@lezer/common', '@lezer/highlight', '@lezer/lr',
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
