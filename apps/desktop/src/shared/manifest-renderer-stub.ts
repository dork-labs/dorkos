/**
 * Stands in for `@dorkos/shared/manifest` in the desktop renderer bundle
 * (DOR-564).
 *
 * `@dorkos/shared/manifest` is real Node.js code — it uses `fs`, `path`, and
 * `crypto` — and is only ever imported by `DirectTransport` (the Obsidian
 * in-process transport), never by anything the Electron renderer's own import
 * graph reaches. `electron.vite.config.ts`'s `sharedSubpathAliases()` maps
 * every `@dorkos/shared/*` subpath straight to its TypeScript source for
 * Rollup workspace resolution, and that generic mapping is overridden for
 * this one subpath to point here instead.
 *
 * **Why a stub, not silence.** The renderer config used to list this subpath
 * under `build.rollupOptions.external`, on the theory that nothing imports
 * it. Externalizing does not *prevent* an import — it just makes one emit a
 * bare, unresolvable specifier — so the day something in the client's import
 * graph reaches `@dorkos/shared/manifest`, the desktop renderer would fail at
 * runtime with a blank window while the identical web build stayed green,
 * with no build-time signal that anything was wrong. Aliasing to a module
 * that throws immediately turns that into a loud, first-run error with a
 * clear cause, in dev and in a packaged build alike.
 *
 * @module shared/manifest-renderer-stub
 */
throw new Error(
  '@dorkos/shared/manifest cannot run in the Electron renderer — it uses Node.js ' +
    "built-ins (fs, path, crypto) the renderer's sandboxed context does not have. " +
    "It exists for DirectTransport (Obsidian's in-process transport) only. If the " +
    'renderer now genuinely needs something from it, move that piece to a module ' +
    'without Node dependencies, or reach it over the server API instead.'
);
