import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Base JS rules
  js.configs.recommended,

  // TypeScript rules (syntax-only, no type-checking)
  ...tseslint.configs.recommended,

  // General rule overrides (warn-first)
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // TSDoc enforcement (warn-first)
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { jsdoc },
    settings: {
      jsdoc: {
        mode: 'typescript',
        tagNamePreference: { returns: 'returns' },
      },
    },
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          publicOnly: { esm: true, cjs: true, window: false },
        },
      ],
      'jsdoc/require-description': 'warn',
      'jsdoc/require-param-description': 'warn',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns-type': 'off',
      'jsdoc/no-types': 'warn',
      'jsdoc/check-tag-names': ['warn', { definedTags: ['vitest-environment'] }],
    },
  },

  // File size limit: 500 lines max (warn-first)
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },

  // Env var discipline: no raw process.env access outside env.ts
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Import env vars from the app's env.ts instead of accessing process.env directly.",
        },
      ],
    },
  },

  // Prettier must be last — disables all formatting rules
  prettier,
];
