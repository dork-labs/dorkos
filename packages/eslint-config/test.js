/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
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
    },
  },
];
