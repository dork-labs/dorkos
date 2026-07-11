import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-obsidian/**', '.turbo/**', 'build-plugins/**'] },
  ...reactConfig,
  ...testConfig,

  // The plugin has no Zod-validated env.ts (it's an embedded Electron entry
  // point, not a server): mirrors the CLI's own process.env.DORK_HOME carve-out
  // (packages/cli/eslint.config.js).
  {
    files: ['src/lib/dork-home.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
