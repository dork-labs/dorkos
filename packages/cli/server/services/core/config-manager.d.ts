// Type-only mirror of `apps/server/src/services/core/config-manager.ts`.
//
// WHY THIS DIRECTORY EXISTS
// -------------------------
// The CLI entry imports the server through specifiers that only resolve in the
// PUBLISHED dist layout, where `dist/bin/cli.js` sits next to `dist/server/`:
//
//     await import('../server/services/core/config-manager.js')
//
// From source (`packages/cli/src/`) that path points nowhere. `scripts/build.ts`
// bridges the gap at bundle time with `serverServicesRedirectPlugin`, which
// rewrites `**/../server/services/<rest>.js` to `apps/server/src/services/<rest>.ts`.
//
// tsc needs the same bridge and cannot use the same mechanism: tsconfig `paths`
// is only consulted for NON-relative specifiers, so no `paths` entry can ever
// match `../server/...` (verified against `tsc --traceResolution`). What tsc does
// honour is the filesystem, so this directory reproduces the dist layout in
// declarations only. Every specifier in the list above lands here — `../server/`
// from `src/`, `../../server/` from `src/commands/`, `../../../server/` from
// `src/commands/telemetry/` — exactly as the plugin's depth-insensitive regex
// treats them.
//
// These files are declarations, never emitted, and `files` in package.json does
// not publish them. They exist so the typecheck reads the same program that
// ships.
//
// KEEPING THE TWO IN STEP
// -----------------------
// A shim that drifts from the plugin means tsc checks a different program than
// esbuild bundles — the exact failure this directory is meant to prevent. So the
// mirror is not maintained by hand-discipline: `src/__tests__/server-shims.test.ts`
// scans the CLI source for `../server/...` imports, applies the plugin's own
// rewrite rule, and fails if a shim is missing, points somewhere else, or is
// left behind after its import is deleted. Add a server import, run the tests,
// and it tells you the file to create and the line to put in it.
export * from '../../../../../apps/server/src/services/core/config-manager.js';
