import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

export function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const root = path.resolve(__dirname, '..');
      fs.copyFileSync(
        path.resolve(root, 'manifest.json'),
        path.resolve(root, 'dist/manifest.json'),
      );
    },
  };
}
