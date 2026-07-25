import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve `@dorkos/shared/config-schema` to the package's SOURCE, not its
    // built `dist/`.
    //
    // The `exports` map points `default` at `dist/`, so without this a stale dist
    // silently tests yesterday's schema. That is a false PASS, not a loud
    // failure, and it defeats the config-disclosure drift guard specifically:
    // that guard enumerates the leaves of `UserConfigSchema` to prove every
    // config field has been classified for the tokenless `config_get` surface, so
    // against a stale dist a newly added field reads as "already classified".
    // `pnpm test` is safe (turbo's `^build`), but the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes is not, and that is
    // where the next author actually stands.
    //
    // Scoped to this one module on purpose. Aliasing all 42 subpaths made every
    // worker re-transform the whole package and took the suite from ~51s to
    // ~110s (transform 97s); scoped, it costs nothing measurable (~37s). All
    // three measured in one session, because machine load moves these numbers
    // more than the alias does. The trade-off is that
    // `dist/schemas.js` reaches config-schema by a relative import, which this
    // alias does not rewrite, so a test process can hold both the src and dist
    // copies. That is safe here and only here: the module has no mutable state and
    // exports only Zod schemas plus plain constants, nothing whose identity is
    // ever compared. Do not widen this alias without re-measuring.
    alias: [
      {
        find: '@dorkos/shared/config-schema',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/config-schema.ts', import.meta.url)
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
