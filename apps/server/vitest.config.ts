import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve a few `@dorkos/shared` subpaths to the package's SOURCE, not its
    // built `dist/`.
    //
    // The `exports` map points `default` at `dist/`, so without this a stale dist
    // silently tests yesterday's module. That is a false PASS, not a loud
    // failure. `pnpm test` is safe (turbo's `^build`), but the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes is not, and that is
    // where the next author actually stands.
    //
    // Both entries below are here because they back a DRIFT GUARD — a test whose
    // whole job is to notice that a table grew a row. Those are exactly the tests
    // a stale dist turns into decoration, because the guard reads the old table,
    // finds it consistent, and reports success:
    //
    // - `config-schema` backs the config-disclosure guard, which enumerates the
    //   leaves of `UserConfigSchema` to prove every config field has been
    //   classified for the tokenless `config_get` surface. Against a stale dist a
    //   newly added field reads as "already classified".
    // - `mcp-tool-groups` backs the tool-group guards, and it decides
    //   `buildAllowedTools`, which is an APPROVAL BYPASS list (see
    //   `services/runtimes/claude-code/tooling/tool-filter.ts`). Measured against
    //   a stale dist: moving `tasks_delete` into an always-on group, making a
    //   destructive tool permanently auto-approved, passed all 85 targeted tests
    //   AND `tsc`, because the type-level assertions only compare key SETS and the
    //   keys had not changed. With the alias the same edit fails immediately.
    // - `@dorkos/operating-skills` backs the tier-consistency guard
    //   (`services/core/__tests__/operating-skills-tier-consistency.test.ts`),
    //   which reads the SKILL PROSE agents are seeded with and checks it against
    //   `MCP_TOOL_TIERS`. Its whole subject is the text of that package, so a dist
    //   copy is the wrong text by construction: reintroducing "carries no gate of
    //   its own" in `src/` would pass against a dist built before the edit. That is
    //   the DOR-509 bug itself, checked by a test that cannot see it.
    //
    // Scoped to these modules on purpose. Aliasing all 43 subpaths made every
    // worker re-transform the whole package and took the suite from ~51s to
    // ~110s (transform 97s); scoped, it costs nothing measurable. Adding the
    // second entry was re-measured in one session, back to back: 50.7s to 52.9s
    // total, transform 18.9s to 19.4s. Both runs were dominated by a 45s flaky
    // watcher integration test, so treat transform time as the signal here and
    // total time as noise, and re-measure in ONE session rather than comparing
    // against a number written down on a different day. The trade-off is
    // that other `dist/*.js` files reach these modules by relative imports, which
    // this alias does not rewrite, so a test process can hold both the src and
    // dist copies. That is safe for these two and only because of what they are:
    // no mutable state, and they export only Zod schemas, plain constants, and
    // pure functions over them, nothing whose identity is ever compared. Do not
    // widen this alias without re-measuring.
    alias: [
      {
        find: '@dorkos/shared/config-schema',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/config-schema.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/mcp-tool-groups',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/mcp-tool-groups.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/operating-skills',
        replacement: fileURLToPath(
          new URL('../../packages/operating-skills/src/index.ts', import.meta.url)
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    // Vitest 4 no longer auto-excludes dist/, and `tsc` emits compiled
    // *.test.js there — scope discovery to source like every other package.
    include: ['src/**/__tests__/**/*.test.ts'],
    // Gate runs (lefthook pre-push, CI) set VITEST_RETRY to absorb timing flake
    // in integration tests. It rides turbo's globalPassThroughEnv, so it never
    // forks the cache key; dev runs get retry: 0 and surface flake loudly.
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/test-utils/**'],
    },
  },
});
