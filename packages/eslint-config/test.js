import { dorkosPlugin } from './base.js';

/**
 * A recorded timestamp asserted against a later real-clock reading
 * (`.claude/rules/testing.md`, "Comparing a recorded timestamp", DOR-1716,
 * DOR-4938). `Date.now()` runs after production read the clock, so the margin
 * is whatever the runner had left, and a quantized or skewed value has none.
 * Both directions: `x <= Date.now()` and `Date.now() >= x`.
 */
const DATE_NOW_BOUND_MESSAGE =
  'A timestamp checked against a later Date.now() is a race. Capture before and after at the call, or freeze the clock (vi.setSystemTime). See .claude/rules/testing.md.';
const IS_DATE_NOW = "[callee.object.name='Date'][callee.property.name='now']";
/** The test-file selectors of `dorkos/restricted-syntax`. A block that sets the rule for tests restates these. */
export const TEST_RESTRICTED_SYNTAX = [
  {
    selector: `CallExpression[callee.property.name=/^toBeLessThan(OrEqual)?$/][arguments.length=1] > CallExpression.arguments${IS_DATE_NOW}`,
    message: DATE_NOW_BOUND_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=/^toBeGreaterThan(OrEqual)?$/] > MemberExpression.callee > CallExpression.object[callee.name='expect'] > CallExpression.arguments${IS_DATE_NOW}`,
    message: DATE_NOW_BOUND_MESSAGE,
  },
];

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    plugins: { dorkos: dorkosPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'require-yield': 'off',
      'react/display-name': 'off',
      'max-lines': 'off',
      // Tests are exempt from HAVING a TSDoc block, not from writing a valid
      // one. Only these two are off; `jsdoc/check-tag-names`, `jsdoc/no-types`
      // and `jsdoc/require-param-description` still apply here, and all of them
      // are `error` since DOR-627 — so a test file with no doc comments at all
      // passes, while one carrying a misspelled tag or an inline type fails.
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'dorkos/restricted-syntax': ['error', ...TEST_RESTRICTED_SYNTAX],
    },
  },
];
