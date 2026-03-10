import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...baseConfig,

  // Zod schema collections — exempt from max-lines
  {
    files: ['src/schemas.ts', 'src/*-schemas.ts'],
    rules: { 'max-lines': 'off' },
  },

  ...testConfig,
]);
