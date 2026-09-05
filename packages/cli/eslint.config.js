import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';

export default defineConfig([
  // core-extensions/ is build output copied by scripts/build.ts (DOR-245) —
  // raw apps/server source staged alongside dist/, not authored here.
  { ignores: ['dist/**', 'core-extensions/**', '.turbo/**'] },
  ...nodeConfig,

  // process.env carve-outs (CLI-specific). `**/*.config.ts` was here until
  // DOR-1785 — the shared preset now carves out every build/tool config file
  // repo-wide, so only the CLI's own exemptions remain.
  {
    files: ['src/cli.ts', 'src/config-commands.ts', '**/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
