import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-server/**',
      '**/dist-obsidian/**',
      '**/.turbo/**',
      '**/coverage/**',
      '.scratch/**',
      '**/build-plugins/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

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
      'jsdoc/check-tag-names': 'warn',
    },
  },

  // React rules (client + obsidian plugin)
  {
    files: ['apps/client/src/**/*.{ts,tsx}', 'apps/obsidian-plugin/src/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React
      ...react.configs.flat.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'warn',
      'react/display-name': 'warn',

      // React Hooks — spread recommended, then downgrade compiler rules to warn
      ...reactHooks.configs['recommended-latest'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler rules (bundled in react-hooks v7) — warn-first
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/incompatible-library': 'off',

      // Accessibility (all warnings)
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/interactive-supports-focus': 'warn',
    },
  },

  // FSD Layer Enforcement: shared/ cannot import higher layers
  {
    files: ['apps/client/src/layers/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/entities/*', '@/layers/entities'],
              message: 'FSD violation: shared/ cannot import from entities/',
            },
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: shared/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: shared/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  // FSD Layer Enforcement: entities/ cannot import features or widgets
  {
    files: ['apps/client/src/layers/entities/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: entities/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: entities/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  // FSD Layer Enforcement: features/ cannot import widgets
  // Note: Cross-feature UI composition is allowed, cross-feature model imports are
  // enforced by the Claude Code rule in .claude/rules/fsd-layers.md
  {
    files: ['apps/client/src/layers/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: features/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  // Env var discipline: no raw process.env access outside env.ts
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn', // warn-first per project convention; escalate to error once migration verified
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Import env vars from the app's env.ts instead of accessing process.env directly.",
        },
      ],
    },
  },

  // Carve-outs for files that legitimately access process.env
  {
    files: [
      '**/env.ts',                                    // env.ts files read process.env by design
      '**/*.config.ts',                               // vite.config.ts, playwright.config.ts run in Node before bundling
      '**/__tests__/**',                              // tests stub process.env for mocking
      '**/*.test.ts',                                 // flat test files
      '**/*.spec.ts',                                 // e2e spec files
      'packages/cli/src/cli.ts',                      // CLI bootstrap sets env vars for server subprocess
      'packages/cli/src/config-commands.ts',          // reads process.env.EDITOR (OS system var, not DorkOS-owned)
      'apps/server/src/lib/dork-home.ts',             // bootstrap utility; runs before env.ts initializes
      'apps/server/src/lib/logger.ts',                // reads NODE_ENV at call time (initLogger called at request time)
      'apps/server/src/routes/tunnel.ts',             // reads tunnel vars at request time (written by CLI bootstrap after env.ts loads)
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Test file overrides — relax strict rules
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
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
    },
  },

  // Prettier must be last — disables all formatting rules
  prettier
);
