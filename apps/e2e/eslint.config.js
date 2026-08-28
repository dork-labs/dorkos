import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  // `.temp/**` is gitignored scratch — self-test drivers and capture leftovers
  // written by a session, never committed and never seen by CI. Linting it made
  // the local pre-commit gate red on somebody else's throwaway file.
  { ignores: ['.turbo/**', 'test-results/**', 'playwright-report/**', '.temp/**'] },
  ...baseConfig,
]);
