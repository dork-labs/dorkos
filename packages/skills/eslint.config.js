import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

// gray-matter `eval`s any frontmatter block that opens with `---js`, so every
// read and write goes through src/frontmatter.ts, which refuses those blocks
// (DOR-2308). scripts/__tests__/gray-matter-import-boundary.test.ts holds the
// same line across the whole repo.
const GRAY_MATTER_BAN = {
  group: ['gray-matter', 'gray-matter/*'],
  message:
    "gray-matter runs `---js` frontmatter as code. Use parseFrontmatter/stringifyFrontmatter from './frontmatter.js' (or '@dorkos/skills/frontmatter').",
};

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/frontmatter.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [GRAY_MATTER_BAN] }] },
  },
  ...testConfig,
]);
