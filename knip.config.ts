import type { KnipConfig } from 'knip';

/**
 * Knip configuration for the DorkOS Turborepo.
 *
 * Knip auto-discovers the pnpm workspaces from `pnpm-workspace.yaml` and infers
 * most entry points from each package's `main` / `bin` / `exports` plus the
 * configs of recognized tools (Vite, Vitest, Next.js, Electron, Turbo, ESLint).
 * This file only encodes what auto-detection cannot know about this repo.
 *
 * Prerequisite: run after the workspace package dists exist (e.g. once
 * `pnpm build` has run), so cross-package `@dorkos/*` imports resolve — the same
 * prerequisite `pnpm typecheck` has.
 *
 * Each exception below is documented because it is NOT dead code, it is code
 * whose only entry point or consumer is invisible to static analysis:
 *
 *  - `.claude/` and `.agents/` — agent-harness tooling (hooks, skills, scripts)
 *    invoked by the Claude Code harness via settings, never imported by the app.
 *  - `apps/server/src/core-extensions/**` — JSX-in-`.ts` modules compiled and
 *    loaded at runtime by the esbuild core-extension host; nothing imports them.
 *  - shadcn/ui registries — added on-demand, the full registry is intentionally
 *    kept. Treated as entry so the components, their exported prop types, AND
 *    their backing deps (Radix, etc.) all stay accounted for.
 *  - `apps/desktop` Electron entries — electron-vite wires `main`, `preload`,
 *    and the bundled `server-entry`; knip's plugin cannot follow that.
 *  - `dorkos` CLI — an esbuild bundle that pulls in `@dorkos/server` by relative
 *    path, so the server's runtime deps live in the CLI manifest but are never
 *    imported by CLI source directly.
 */
const config: KnipConfig = {
  // The root workspace covers everything outside apps/* and packages/*. The
  // agent harness and prose dirs are not application code; `templates/` holds
  // scaffolding copied to users on demand, not imported here.
  ignore: ['.claude/**', '.agents/**', 'templates/**'],

  // `gh` (GitHub CLI) is an intentional external system dependency, shelled out
  // to by the template downloader — not an installable package.
  ignoreBinaries: ['gh'],

  workspaces: {
    'apps/client': {
      // shadcn/ui add-on-demand registry (main.tsx + test-setup are auto-detected).
      entry: ['src/layers/shared/ui/**/*.{ts,tsx}'],
      ignore: [
        // Per-app Zod env convention (AGENTS.md): present even before any VITE_* var exists.
        'src/env.ts',
        // One-shot generator for the committed notification.mp3 asset; run manually.
        'scripts/generate-notification-sound.ts',
      ],
    },
    'apps/server': {
      // Runtime-compiled extensions loaded by the esbuild core-extension host.
      entry: ['src/core-extensions/**/*.{ts,tsx}'],
      // Marketplace install fixtures are intentionally standalone sample packages.
      ignore: ['src/services/marketplace/fixtures/**'],
    },
    'apps/desktop': {
      entry: [
        'electron.vite.config.ts',
        'src/main/index.ts',
        'src/preload/index.ts',
        'src/server-entry.ts',
      ],
      // Build- and bundle-time deps the Electron build needs but no source file
      // imports statically: the renderer (`@dorkos/client` + `tailwindcss`), the
      // native-module rebuild step (`@electron/rebuild`), and the bundled server
      // runtime (`@dorkos/shared`, `@dorkos/db`, `better-sqlite3`).
      ignoreDependencies: [
        '@dorkos/client',
        '@dorkos/db',
        '@dorkos/shared',
        '@electron/rebuild',
        'better-sqlite3',
        'tailwindcss',
      ],
    },
    'apps/site': {
      // shadcn/ui add-on-demand registry in the marketing app.
      entry: ['src/components/ui/**/*.{ts,tsx}'],
    },
    'packages/cli': {
      // Bundled into the CLI through `@dorkos/server` (esbuild), or required by
      // the bundled server at runtime; the CLI's own source never imports these
      // directly, so static analysis cannot see the usage.
      ignoreDependencies: [
        '@anthropic-ai/claude-agent-sdk',
        '@anthropic-ai/sdk',
        '@asteasolutions/zod-to-openapi',
        '@modelcontextprotocol/sdk',
        '@ngrok/ngrok',
        '@scalar/express-api-reference',
        'conf',
        'cors',
        'express',
        'gray-matter',
        'uuid',
      ],
      // The CLI resolves the server by relative path at bundle time; these
      // specifiers are unresolvable until esbuild stitches the two together.
      ignoreUnresolved: [/^\.\.\/server\//],
    },
  },
};

export default config;
