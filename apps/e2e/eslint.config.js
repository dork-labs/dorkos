import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  { ignores: ['.turbo/**', 'test-results/**', 'playwright-report/**'] },
  ...baseConfig,
]);
