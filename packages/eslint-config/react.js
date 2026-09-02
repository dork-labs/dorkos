import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import baseConfig from './base.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...baseConfig,

  // React rules
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: {
        // An explicit version, NOT `'detect'` (DOR-169). Under ESLint 10
        // `'detect'` crashes the whole lint run before a single file is
        // reported: eslint-plugin-react resolves the version by calling
        // `context.getFilename()` (`lib/util/version.js`), one of the
        // deprecated `context` methods ESLint 10 removed, and that call site is
        // the one place in the plugin with no `sourceCode`-first fallback. The
        // failure is a `TypeError: contextOrFilename.getFilename is not a
        // function` inside whichever rule happened to initialise first, so it
        // reads like a broken rule rather than a version lookup.
        //
        // The plugin declares no ESLint 10 peer (7.37.5 caps at `^9.7`) and has
        // no release that fixes this, so pinning is the fix, not a stopgap.
        // Everything else in the plugin routes through the guarded shim in
        // `lib/util/eslint.js` and works on 10; `jsx-filename-extension` is the
        // only other unguarded caller and this config does not enable it.
        //
        // Keep this in step with the `react` version in `apps/client` and
        // `apps/site` — the plugin reads it to gate rules on React features, so
        // a stale value silently applies an older React's rule set.
        version: '19.2',
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
];
