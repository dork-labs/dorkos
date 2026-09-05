import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { clientDefines } from './vite-define';

export default defineConfig({
  // Shared with the desktop shell's renderer build, which bundles this same
  // source — see `vite-define.ts` for what an unshared `define` costs.
  define: clientDefines(),
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    // Resolve a few `@dorkos/shared` subpaths to the package's SOURCE, not its
    // built `dist/`. This is `test.alias`, NOT `resolve.alias`, on purpose: it
    // applies only under Vitest, so the shipped browser bundle keeps resolving
    // the package's `exports` map exactly as it does today.
    //
    // The `exports` map points `default` at `dist/`, so without this a stale dist
    // silently tests yesterday's module. That is a false PASS, not a loud failure.
    // `pnpm test` is safe (turbo's `^build`), but the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes is not, and that is where
    // the next author actually stands.
    //
    // Every entry backs a DRIFT GUARD — a test whose whole job is to notice that a
    // table grew a row, which is exactly the test a stale dist turns into
    // decoration:
    //
    // - `session-stream` backs the two schema-drift pins in
    //   `transport/__tests__/stream-manager.test.ts` and the third in
    //   `session-stream-methods.test.ts`. They introspect `SessionEventSchema` /
    //   `SessionListEventSchema` discriminants and pin them against the SSE event
    //   names the client registers listeners for. A name missing from an allowlist
    //   is a frame `EventSource` drops in silence, so a guard that reads the old
    //   union is worse than none.
    // - `config-schema` backs `status/__tests__/status-bar-registry.test.ts`, which
    //   pins the pinnable registry items against the `ui.statusBar.pins` enum.
    // - `constants` backs the two `STATUS_VALUE_MAX_CHARS` budget assertions that
    //   compare something INDEPENDENT against the constant — `status-labels` (a
    //   truncated label's length) and `ConnectionItem` (a rendered label's length).
    //   Shrink the budget in `src/` and a stale dist measures against the old,
    //   roomier one. `status-budget` imports the same constant but is NOT in this
    //   set: it derives `STATUS_VALUE_MAX_CHARS * 8 + 20` and compares that against
    //   `FULL_SLOT_COST_PX`, which derives from the constant too, so both sides move
    //   together and it stays green at `STATUS_VALUE_MAX_CHARS = 3`. It rides the
    //   alias because it shares the module, not because the alias buys it anything.
    // - `trait-renderer` backs `agent/__tests__/trait-sliders.test.tsx`, which is
    //   an exhaustive loop over `TRAIT_ORDER`: a new trait read from a stale dist
    //   produces zero extra assertions and a green run.
    // - `relay-schemas` backs `relay/ui/__tests__/AdapterSetupWizardUnclaimedFields.test.tsx`,
    //   which asserts what the adapter wizard paints for a manifest whose fields
    //   and setup steps disagree. The rule it paints by (`setupStepFields`) lives
    //   in the package, so a stale dist renders yesterday's rule — and the
    //   negative assertions (no "Advanced" heading for a manifest with no setup
    //   steps) stay green while the shipped rule regresses.
    // - `permission-semantics` backs the consent-gate drift tests: the four
    //   surfaces that must open the same dialog for the same mode —
    //   `chat/__tests__/ChatStatusSection-autonomy-door.test.tsx`,
    //   `binding/ui/__tests__/BindingAdvancedSection.test.tsx`,
    //   `tasks/__tests__/CreateTaskDialog.test.tsx` and the scope note's own
    //   suite — all decide by `needsConsentRitual`, whose whole job is to say
    //   that a mode nobody thought about (a runtime that never asks at the
    //   MIDDLE stop) still needs consent. Same family as the rest: a rule whose
    //   source text is the subject. Measured: narrowing the predicate back to
    //   `isAutonomyStop` in `src/` with a stale dist reddened 0 of those tests —
    //   they read yesterday's rule and passed — and 6 with this entry.
    //
    // Scoped to these six on purpose — see the same note in
    // `apps/server/vitest.config.ts` for what widening to all 43 subpaths cost.
    alias: [
      {
        find: '@dorkos/shared/session-stream',
        replacement: path.resolve(__dirname, '../../packages/shared/src/session-stream.ts'),
      },
      {
        find: '@dorkos/shared/config-schema',
        replacement: path.resolve(__dirname, '../../packages/shared/src/config-schema.ts'),
      },
      {
        find: '@dorkos/shared/constants',
        replacement: path.resolve(__dirname, '../../packages/shared/src/constants.ts'),
      },
      {
        find: '@dorkos/shared/trait-renderer',
        replacement: path.resolve(__dirname, '../../packages/shared/src/trait-renderer.ts'),
      },
      {
        find: '@dorkos/shared/relay-schemas',
        replacement: path.resolve(__dirname, '../../packages/shared/src/relay-schemas.ts'),
      },
      {
        find: '@dorkos/shared/permission-semantics',
        replacement: path.resolve(__dirname, '../../packages/shared/src/permission-semantics.ts'),
      },
    ],
    // Ensure React loads development bundles (act, error messages) even when
    // the host shell has NODE_ENV=production.
    env: { NODE_ENV: 'test' },
    setupFiles: ['./src/test-setup.ts'],
    // Honors the pre-push gate's VITEST_RETRY budget; 0 for dev and CI runs.
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    server: {
      // Inline jest-dom so Vitest resolves its transitive deps (redent,
      // @adobe/css-tools, dom-accessibility-api) from the pnpm store
      // rather than requiring them to be hoisted into apps/client/node_modules.
      deps: {
        inline: ['@testing-library/jest-dom'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**'],
    },
  },
  root: '.',
  publicDir: 'public',
  optimizeDeps: {
    // Pin streamdown into the initial dep-optimization pass. It renders code
    // blocks through a lazily-imported chunk (its syntax-highlighted body); if
    // that chunk's optimized hash is regenerated by a mid-session
    // re-optimization, an already-loaded page holds a stale chunk URL and the
    // dynamic import 404s ("Failed to fetch dynamically imported module").
    // Including streamdown keeps its optimize inputs — and therefore its chunk
    // hashes — stable across re-optimizations. The render seam is also guarded
    // by MarkdownErrorBoundary, which covers prod redeploys where dev
    // pre-bundling doesn't apply.
    include: ['streamdown'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT) || 4241,
    allowedHosts: ['.ngrok-free.app'],
    ...(process.env.TUNNEL_ENABLED === 'true' && { hmr: { clientPort: 443 } }),
    // **The browser suite gets a dev server that never hot-replaces anything**
    // (DOR-1412). Set by both Vite legs in `apps/e2e/playwright.config.ts`, and
    // by nothing else — a person running `pnpm dev` is editing files on purpose
    // and wants the update. Last of the `hmr` spreads so it wins outright.
    //
    // Nothing in that suite edits source, but plenty rewrites the files this
    // server watches: every Express leg boots by running `turbo run build`,
    // which rewrites `packages/*/dist` — modules this client imports — and this
    // repo is routinely several agents deep in one checkout, any of whom may
    // build at any moment. Vite then hot-replaces the modules above the change,
    // a re-evaluated context module mints a NEW React context object while
    // already-mounted consumers still hold the old one, `useContext` answers
    // `undefined`, and the provider's own guard throws. The whole app is
    // replaced by its error boundary mid-test, and the spec fails on whatever
    // it was asserting — "expected 1, received 0" — which reads like the
    // feature under test rendering nothing. It was the "roughly 1 run in 10,
    // any spec" flake in `apps/e2e/GOTCHAS.md`.
    //
    // Measured 2026-09-04, one spec run 40 times while a loop rewrote
    // `packages/shared/dist`: 10 262 hot updates and 8 of 40 attempts red, 7 of
    // them showing that exact error boundary. The same run with this flag: 0.
    //
    // `hmr: false` is the whole stop, inside Vite: its watcher calls
    // `handleHMRUpdate` behind `if (serverConfig.hmr !== false)`, so a file
    // change during a run produces no update to push and no module to
    // re-evaluate.
    ...(process.env.DORKOS_E2E_NO_HMR === 'true' && { hmr: false }),
    watch: {
      ignored: ['**/state/**'],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.DORKOS_PORT || DEFAULT_PORT}`,
        changeOrigin: true,
        // Proxy WebSocket upgrades too, not just requests. Without this the dev
        // server answers `/api/**` upgrades itself — with nothing — so every
        // durable stream (session, global, room) and the embedded terminal are
        // dead in dev while working perfectly in a production build, where the
        // server serves the SPA and the API on one origin and there is no proxy
        // in between. Found the hard way: the cockpit rendered, the turn ran
        // server-side, and the reply never arrived on screen.
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
      // @dorkos/shared/manifest uses Node.js built-ins (fs, path, crypto) and
      // is only consumed by DirectTransport in Electron/Obsidian. Externalize
      // it from the browser bundle to prevent Vite from inlining Node modules.
      external: ['@dorkos/shared/manifest'],
    },
  },
});
