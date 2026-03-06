import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...nodeConfig,

  // process.env carve-outs (CLI-specific)
  {
    files: ['src/cli.ts', 'src/config-commands.ts', '**/env.ts', '**/*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
