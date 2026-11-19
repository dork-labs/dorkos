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

  // External system commands: GitHub CLI for templates; Linux's desktop URL opener.
  ignoreBinaries: ['gh', 'xdg-open'],

  workspaces: {
    '.': {
      entry: [
        // Invoked by the required typecheck workflow, outside the app import graph.
        'scripts/check-knip.ts!',
        // Run by hand to refresh test fixtures from the Composio catalog
        // (contributing/connections-security-verification.md).
        'scripts/composio-repository-write-arguments.mjs',
        'scripts/composio-money-word-candidates.mjs',
      ],
    },
    'apps/client': {
      // shadcn/ui add-on-demand registry (main.tsx + test-setup are auto-detected).
      // The space's own website (server-merge step 7e) is a second entry, built by
      // vite.space.config.ts.
      entry: ['src/layers/shared/ui/**/*.{ts,tsx}', 'src/space/main.tsx', 'vite.space.config.ts'],
      ignoreDependencies: [
        '@radix-ui/react-alert-dialog', // Settings tests import the real primitive behind their mocks.
        '@radix-ui/react-dialog', // Settings tests import the real primitive behind their mocks.
        '@radix-ui/react-tabs', // QuestionPrompt tests supply the primitive's mock.
        '@reactour/tour', // TourSpotlight imports this from the shared UI registry.
        'cmdk', // The shared UI registry's command.tsx imports this.
        'vaul', // The shared UI registry's drawer.tsx imports this.
        'tw-animate-css', // Animation regression tests read the installed stylesheet from disk.
      ],
      ignore: [
        // Per-app Zod env convention (AGENTS.md): present even before any VITE_* var exists.
        'src/env.ts',
        // One-shot generator for the committed notification.mp3 asset; run manually.
        'scripts/generate-notification-sound.ts',
        // One-shot generator for the committed PWA icon PNGs; run manually.
        'scripts/generate-pwa-icons.ts',
      ],
    },
    'apps/server': {
      // Runtime-compiled extensions loaded by the esbuild core-extension host.
      entry: ['src/core-extensions/**/*.{ts,tsx}'],
      ignoreDependencies: [
        '@openai/codex', // check-dependencies.ts resolves the CLI's package.json and native binary.
        '@noble/curves', // Buzz identity signing imports schnorr from the secp256k1.js subpath.
      ],
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
      // runtime (`@dorkos/shared`, `@dorkos/db`, `better-sqlite3`), and `hono`,
      // which the extension compiler reads from disk to bundle into extensions
      // (`apps/server/src/services/extensions/server-bundle/host-hono.ts`).
      ignoreDependencies: [
        '@anthropic-ai/claude-agent-sdk', // build-server.ts external; electron-builder unpacks its binary.
        '@anthropic-ai/sdk', // Explicit agent SDK peer pin; dependabot-lockstep-families.test.ts guards it.
        '@asteasolutions/zod-to-openapi', // build-server.ts server-bundle external.
        '@composio/core', // build-server.ts server-bundle external.
        '@dorkos/client',
        '@dorkos/db',
        '@dorkos/server', // src/server-entry.ts loads the server through the build's source plugin.
        '@dorkos/shared',
        '@electron/rebuild',
        '@ngrok/ngrok', // build-server.ts external; electron-builder unpacks its native binary.
        '@openai/codex', // Binary parent pin checked by build-server.ts's platform-family guard.
        '@openai/codex-sdk', // build-server.ts server-bundle external.
        '@opencode-ai/sdk', // build-server.ts server-bundle external.
        'better-sqlite3',
        'conf', // build-server.ts server-bundle external.
        'cors', // build-server.ts server-bundle external.
        'dotenv', // build-server.ts server-bundle external.
        'esbuild', // Extension compilation needs its on-disk native executable.
        'express', // build-server.ts external for the extension HTTP bridge.
        'hono',
        'node-pty', // build-server.ts external; electron-builder unpacks the native terminal addon.
        'tailwindcss',
        'uuid', // build-server.ts server-bundle external.
      ],
    },
    'apps/site': {
      // shadcn/ui add-on-demand registry in the marketing app.
      entry: ['src/components/ui/**/*.{ts,tsx}'],
      ignoreDependencies: [
        '@base-ui/react', // The UI registry imports its primitive subpaths.
        'class-variance-authority', // The UI registry imports cva and VariantProps.
        'cmdk', // The UI registry's command.tsx imports this.
        'embla-carousel-react', // The UI registry's carousel.tsx imports this.
        'input-otp', // The UI registry's input-otp.tsx imports this.
        'react-day-picker', // The UI registry's calendar.tsx imports this.
        'react-resizable-panels', // The UI registry's resizable.tsx imports this.
        'sonner', // The UI registry's sonner.tsx imports this for app/providers.tsx.
        'vaul', // The UI registry's drawer.tsx imports this.
      ],
    },
    'apps/e2e': {
      // Measurement scripts run by hand against an app the operator started
      // (see each file's header for the command). They are entry points with no
      // importer by design — a spec that ran them would turn a benchmark into a
      // gate, which is the opposite of what they are for.
      entry: ['perf/*.ts'],
    },
    'apps/space': {
      // The space's web pages live in apps/client (server-merge step 7e), but the space image
      // builds them from this package's install, through a node_modules link in its Dockerfile.
      ignoreDependencies: [
        '@aws-sdk/client-s3', // The server sources in ../server/src/services/spaces use S3 storage.
        '@dork-labs/ui',
        '@dorkos/decisions', // The space build compiles ../server/src/services/spaces/decisions.
        '@dorkos/icons',
        '@dorkos/shared', // The space build compiles the server's shared wire imports.
        '@hono/node-server', // The space's main.ts and browser checks start the Hono server.
        '@tailwindcss/vite',
        '@types/react',
        '@types/react-dom',
        '@vitejs/plugin-react',
        'better-auth', // The space build compiles the server's authentication modules.
        'drizzle-orm', // The space build compiles the server's PostgreSQL queries.
        'fflate', // The space build compiles the server's ZIP export modules.
        'hono', // The space build compiles the server's HTTP routes.
        'lucide-react',
        'nodemailer', // The space build compiles the server's email delivery modules.
        'pg', // The space build compiles the server's PostgreSQL connection module.
        'react',
        'react-dom',
        'tailwindcss',
        'vite',
        'zod', // The space build compiles the server's request validators.
      ],
    },
    'packages/a2a-gateway': {
      ignoreDependencies: [
        '@dorkos/mesh', // Executor tests import AgentRegistryEntry from Mesh.
      ],
    },
    'packages/doe': {
      ignoreDependencies: [
        'typebox', // boundary.test.ts pins the audited schema runtime shared by the Pi packages.
      ],
    },
    'packages/cli': {
      // Bundled into the CLI through `@dorkos/server` (esbuild), or required by
      // the bundled server at runtime; the CLI's own source never imports these
      // directly, so static analysis cannot see the usage.
      ignoreDependencies: [
        // Build-graph edges, not imports: scripts/build.ts copies the client's
        // dist and esbuild-inlines the server's source, so turbo must build
        // both (and their transitive deps) before the CLI (DOR-190).
        '@dorkos/client',
        '@dorkos/server',
        '@anthropic-ai/claude-agent-sdk',
        '@anthropic-ai/sdk',
        '@asteasolutions/zod-to-openapi',
        '@composio/core', // scripts/build.ts server-bundle external.
        '@modelcontextprotocol/sdk',
        '@ngrok/ngrok',
        '@openai/codex', // The bundled server resolves the CLI package and its native binary.
        '@openai/codex-sdk', // scripts/build.ts server-bundle external.
        '@opencode-ai/sdk', // scripts/build.ts server-bundle external.
        'conf',
        'express',
        // Read from disk by the extension compiler, which bundles DorkOS's own
        // copy into every extension's server half (`server-bundle/host-hono.ts`).
        'hono',
        'node-pty', // scripts/build.ts external for the native terminal addon.
        'playwright-core', // scripts/build.ts external for browser installation and runtime assets.
        'uuid',
      ],
      // No `ignoreUnresolved: [/^\.\.\/server\//]` any more. The CLI still
      // reaches the server by a dist-layout relative path, but those specifiers
      // now resolve on disk against the declaration mirror in
      // `packages/cli/server/` (added so tsc can check them), so knip finds
      // them the same way tsc does.
    },
  },
};

export default config;
