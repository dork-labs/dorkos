import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

// `src/generated/` is written by `pnpm api-client:generate` from
// docs/api/openapi.json and compared byte for byte by the openapi-fresh check,
// so it is not linted (nor counted by check:max-lines, which reads this config).
export default defineConfig([
  { ignores: ['dist/**', '.turbo/**', 'src/generated/**'] },
  ...baseConfig,
  ...testConfig,
]);
