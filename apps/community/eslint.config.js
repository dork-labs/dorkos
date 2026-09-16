import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-server/**', '.turbo/**'] },
  ...nodeConfig,
  ...reactConfig.map((entry) => ({ ...entry, files: ['src/browser/**/*.{ts,tsx}'] })),
  ...testConfig,
]);
