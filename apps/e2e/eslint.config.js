import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  // `.temp/**` is gitignored scratch — self-test drivers and capture leftovers
  // written by a session, never committed and never seen by CI. Linting it made
  // the local pre-commit gate red on somebody else's throwaway file.
  { ignores: ['.turbo/**', 'test-results/**', 'playwright-report/**', '.temp/**'] },
  ...baseConfig,
  // The two-Desktop acceptance run composes the environment of the processes it
  // launches (two packaged apps, two Community servers) and reads its own
  // opt-in settings in one place, config.ts. process.env is that interface,
  // not an app config read an env.ts could own.
  {
    files: ['community-two-desktop/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
