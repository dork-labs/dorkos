import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...baseConfig,
  // test-utils is entirely test infrastructure — relax rules
  ...testConfig,
]);
