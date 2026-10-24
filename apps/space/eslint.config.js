import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-server/**', '.turbo/**'] },
  ...nodeConfig,
  ...testConfig,
]);
