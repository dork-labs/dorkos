import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';

export default defineConfig([
  // core-extensions/ is build output copied by scripts/build.ts (DOR-245) —
  // raw apps/server source staged alongside dist/, not authored here.
  { ignores: ['dist/**', 'core-extensions/**', '.turbo/**'] },
  ...nodeConfig,

  // process.env carve-outs (CLI-specific)
  {
    files: ['src/cli.ts', 'src/config-commands.ts', '**/env.ts', '**/*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
