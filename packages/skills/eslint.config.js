import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

// gray-matter `eval`s any frontmatter block that opens with `---js` (DOR-2308)
// and strips comments with a quadratic regular expression before any size
// check can run (DOR-2311). src/frontmatter.ts reads frontmatter itself, so
// nothing in this package imports gray-matter.
// scripts/__tests__/gray-matter-import-boundary.test.ts holds the same line
// across the whole repo.
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
    rules: { 'no-restricted-imports': ['error', { patterns: [GRAY_MATTER_BAN] }] },
  },
  ...testConfig,
]);
