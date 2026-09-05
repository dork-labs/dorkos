import { defineConfig } from 'eslint/config';
import globals from 'globals';
import baseConfig from '@dorkos/eslint-config/base';

// The repo-root ESLint config. It governs everything OUTSIDE a workspace
// package: `scripts/`, `.claude/`, `.agents/`, `templates/`, and the root
// config files themselves. `apps/**` and `packages/**` are ignored here because
// each of them owns a config of its own, which `turbo lint` runs per package.
//
// That split is the whole reason DOR-1696 existed. `turbo lint` only reaches
// tasks that belong to a workspace package, so nothing it runs can see these
// directories, and the one ESLint invocation CI did make outside turbo pointed
// at `scripts/` alone. A repo-root `eslint .` reported 164 errors across
// `.claude/**` and `.agents/**` — 155 of them `no-undef` on `process`,
// `console`, `Buffer`, `window` and friends, because this config declared no
// environment for the .mjs/.cjs/.js files there. These are the hooks and
// automation the repo actually executes (git-guard, process-guard, file-guard,
// the ADR and docs scripts), where a syntax-level break ships silently.
// The `lint` workflow now runs `eslint .` from here, so this config is what
// stands between a broken hook and `main`.
export default defineConfig([
  {
    ignores: [
      'apps/**',
      'packages/**',
      'node_modules/**',
      '.scratch/**',
      'coverage/**',
      'examples/**',

      // Gitignored, machine-local, and NOT ours to lint. ESLint does not read
      // .gitignore, and `eslint .` from the repo root walks dot-directories, so
      // without these a developer's checkout lints marketplace-installed plugin
      // skills (`.claude/skills/*__*`, `.agents/skills/*__*` — third-party
      // source we do not own), turbo's cache, a sibling worktree, or the output
      // of the last eval run. CI checks out a clean tree and would never see
      // any of it, which is exactly the kind of divergence that makes a gate
      // reproducible only on the runner.
      //
      // Every entry names a directory .gitignore lists, but that is not the
      // same as "git knows nothing about it": `.dork/visual-companion/` and
      // `test-results/` still hold files committed before their ignore line
      // existed. What every entry IS, is runtime or machine-local output —
      // written by a tool, not authored here.
      //
      // The three `.dork/` entries are deliberately the subdirectories rather
      // than `.dork/**`. Nothing lintable is tracked under `.dork/` today, and
      // naming the runtime dirs means that if something lintable ever is, it
      // gets linted instead of silently skipped.
      '.claude/skills/*__*/**',
      '.agents/skills/*__*/**',
      '.dork/plugins/**',
      '.dork/flow/**',
      '.dork/visual-companion/**',
      '.turbo/**',
      '.temp/**',
      '.worktrees/**',
      '.yalc/**',
      '.superpowers/**',
      '.evals-runs/**',
      'test-results/**',
    ],
  },
  ...baseConfig,

  // Node globals for the repo's own automation.
  //
  // `.claude/hooks/*.mjs`, `.claude/scripts/*.mjs` and `scripts/**` are Node
  // programs — they read `process.argv`, write to `console`, and handle
  // `Buffer`. TypeScript files never tripped `no-undef` (typescript-eslint's
  // recommended set switches that rule off for them, since the compiler already
  // answers "is this defined"), so the gap was invisible until a plain .mjs
  // was linted. Declaring the environment is the fix: the rule stays ON and
  // keeps catching a genuine typo like `proccess.exit`.
  {
    files: ['.claude/**/*.{js,mjs,cjs}', '.agents/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },

  // ...except this one file, which runs in a page, not in Node. It is the
  // client half of the visual-companion skill's preview server: it talks to
  // `window`, `document` and `WebSocket` and never sees a `process`. Scoped to
  // the single file rather than to the skill directory, so its Node-side
  // sibling (`server.cjs`) keeps the Node environment above.
  {
    files: ['.agents/skills/visual-companion/scripts/helper.js'],
    languageOptions: { globals: globals.browser },
  },

  // `require()` is the only import form a .cjs file has. The shared base config
  // already turns this rule off, but only for `**/*.ts`/`**/*.tsx`, so a file
  // whose extension NAMES it CommonJS was the one place it still fired. Scoped
  // to the extension, not to a directory: a .mjs or .ts file reaching for
  // `require` still gets told off.
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
