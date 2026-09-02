import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Ignore Vite/Vitest transient config snapshots (e.g.
  // `vitest.config.ts.timestamp-*.mjs`). They are gitignored, but ESLint does
  // not read .gitignore, so a stray one left by an interrupted run would
  // otherwise fail lint with `no-undef` on its `process` usage.
  { ignores: ['**/*.timestamp-*.mjs'] },

  // Base JS rules
  js.configs.recommended,

  // `preserve-caught-error` arrives in ESLint 10's recommended set, but its
  // default leaves a one-keystroke bypass: with `requireCatchParameter: false`,
  // `catch (err) { throw new Error(msg) }` is an error while `catch { throw new
  // Error(msg) }` is silently fine — drop the binding and the rule stops
  // looking. That is the opposite of what this gate is for, since a throw that
  // never named the error it was handling has lost strictly more than one that
  // named it and forgot to pass it on (DOR-169).
  //
  // This does NOT demand a parameter on every catch. The option is only
  // consulted inside the rule's `ThrowStatement` handler, so a catch that logs
  // and continues, or swallows deliberately, keeps its bare `catch {}` — the
  // repo has many, and they stay untouched. It fires only where a catch throws.
  {
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
    },
  },

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

  // TSDoc enforcement — AGENTS.md Hard Rule 4, "TSDoc on exports".
  //
  // These are `error`, not `warn` (DOR-627). Every one of them was `warn`
  // until then, and every package's lint script is a bare `eslint .`, which
  // exits 0 on warnings — so the rule this repo calls non-negotiable failed
  // nothing, anywhere: not the lefthook pre-commit hook, not `pnpm verify`,
  // not CI. "Enforced by `eslint-plugin-jsdoc`" was a statement about a
  // plugin being installed. At `error` a missing or empty TSDoc block on an
  // exported symbol fails `eslint`, which fails the `lint` workflow.
  //
  // Only the jsdoc rules were promoted. The other `warn`-severity rules in
  // this file (`max-lines`, `no-restricted-syntax`, `no-unused-vars`) stay
  // warnings and CI passes no `--max-warnings 0`: the repo carries ~210 of
  // them, and clearing `max-lines` alone means splitting 49 large files.
  // Turning the whole board red to enforce one Hard Rule would have blocked
  // this change behind a refactor it has nothing to do with. The per-rule
  // severity IS the gate here — anything meant to fail CI belongs at
  // `error`, and a new `warn` rule is understood to fail nothing.
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { jsdoc },
    settings: {
      jsdoc: {
        mode: 'typescript',
        // `typeParam: 'typeParam'` maps the tag to itself, which is how this
        // plugin is told "this tag is fine as written". Without it,
        // `mode: 'typescript'` resolves `@typeParam` to its Closure spelling and
        // check-tag-names reports "Replace @typeParam with @template" — at
        // `error`, that BANS the correct TSDoc tag, in a repo whose Hard Rule 4
        // is literally "TSDoc on exports". `definedTags` does not fix this: it
        // governs unknown tags, not preference remapping of a known one.
        // Both spellings now pass; `@template` is the older majority here.
        tagNamePreference: { returns: 'returns', typeParam: 'typeParam' },
      },
    },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
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
      'jsdoc/require-description': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns-type': 'off',
      'jsdoc/no-types': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['vitest-environment'] }],
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
