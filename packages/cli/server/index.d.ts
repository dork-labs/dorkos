// Type-only mirror of a module the CLI imports through the DIST layout.
// See ./services/core/config-manager.d.ts for the full explanation and the
// guard test that keeps this tree in step with scripts/build.ts.
//
// `../server/index.js` is the one specifier esbuild leaves EXTERNAL: at runtime
// `dist/bin/cli.js` dynamically imports its sibling `dist/server/index.js`, the
// separately-bundled `apps/server/src/index.ts`.
export * from '../../../apps/server/src/index.js';
