import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-obsidian/**', '.turbo/**', 'build-plugins/**'] },
  ...reactConfig,
  ...testConfig,
]);
