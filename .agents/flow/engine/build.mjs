/**
 * Build the `/flow` engine's oracle CLI scripts (ADR-0294, tasks 1.2 / 1.3).
 *
 * Bundles each `cli/<name>.ts` entrypoint into `.agents/flow/scripts/<name>.mjs`
 * with esbuild ({ bundle: true, format: 'esm', platform: 'node' }). The four pure
 * oracles (dispatch / involvement / gates / recovery) carry only `import type`
 * cross-module imports, so they bundle to zero-runtime-dep `.mjs`; validate-config
 * imports the Zod schema, so esbuild inlines Zod into its bundle.
 *
 * These emitted `.mjs` ARE the shipped artifact: the markdown stage skills run
 * `node .agents/flow/scripts/<name>.mjs` instead of re-deriving the decision
 * ladders in prose.
 *
 * CRITICAL: this emits ONLY the five named outputs and never cleans/wipes the
 * scripts/ directory — other scripts (e.g. the adapter validator) live there.
 *
 * @module @dorkos/flow-engine/build
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const engineDir = path.dirname(fileURLToPath(import.meta.url));
// engine -> flow ; the repo-level flow scripts dir is the emit target.
const scriptsDir = path.resolve(engineDir, '..', 'scripts');

/** The five CLI entrypoints, each bundled to `<name>.mjs` in the scripts dir. */
const ENTRY_NAMES = ['dispatch', 'involvement', 'gates', 'recovery', 'validate-config'];

const entryPoints = ENTRY_NAMES.map((name) => path.join(engineDir, 'cli', `${name}.ts`));

await esbuild.build({
  entryPoints,
  outdir: scriptsDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
});

process.stdout.write(`Built ${ENTRY_NAMES.length} flow oracle scripts -> ${scriptsDir}\n`);
