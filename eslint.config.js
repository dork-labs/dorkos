import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  {
    ignores: [
      'apps/**',
      'packages/**',
      'node_modules/**',
      '.scratch/**',
      'coverage/**',
      'examples/**',
    ],
  },
  ...baseConfig,
]);
