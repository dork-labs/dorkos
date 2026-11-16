/**
 * Vitest global setup for the server project: a fresh folder, for this run
 * only, where the contract harness builds the composed server the first time
 * a contract file boots one (`server-build.ts`), and the boot mode for the run.
 * Nothing is built here, so a run with no contract file in it pays nothing;
 * the folder goes when the run ends, so no run ever boots another run's build.
 *
 * The folder sits under `apps/server/node_modules/.cache/`, not the system
 * temp dir: a bare `import()` left in the bundle (the relay adapter plugin
 * loader's) resolves from the bundle's own folder, and from here Node walks
 * up to `apps/server/node_modules`, as it does for the server's own modules.
 *
 * @module http/__tests__/contract/global-setup
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  BUILD_MS_FILE,
  BOOTED_MARKER_PREFIX,
  CONTRACT_BUILD_ROOT,
  TSX_ESCAPE_FLAG,
  type ContractBootMode,
} from './server-build.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Where this run's contract server build goes. */
    contractServerBuildDir: string;
    /** How this run boots the composed server. */
    contractServerMode: ContractBootMode;
  }
}

/**
 * The boot mode for this run. Under `vitest --watch` the run never ends, so a
 * build made once would go stale as the source changes; watch mode boots with
 * tsx, which reads the source on every boot.
 */
function bootMode(project: TestProject): { mode: ContractBootMode; why: string } {
  if (process.env[TSX_ESCAPE_FLAG] === '1') return { mode: 'tsx', why: `${TSX_ESCAPE_FLAG}=1` };
  if (project.vitest.config.watch) return { mode: 'tsx', why: 'watch mode' };
  return { mode: 'bundle', why: 'built once per run' };
}

/** Make the folder, hand it and the mode to the test workers, and say which mode booted. */
export default function setup(project: TestProject): () => void {
  mkdirSync(CONTRACT_BUILD_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(CONTRACT_BUILD_ROOT, 'run-'));
  const { mode, why } = bootMode(project);
  project.provide('contractServerBuildDir', dir);
  project.provide('contractServerMode', mode);
  return () => {
    // One line per run that booted a contract server, naming how it booted.
    const booted = ['bundle', 'tsx'].filter((m) =>
      existsSync(path.join(dir, BOOTED_MARKER_PREFIX + m))
    );
    if (booted.length > 0) {
      const buildMs = path.join(dir, BUILD_MS_FILE);
      const built = existsSync(buildMs) ? `, build ${readFileSync(buildMs, 'utf8')} ms` : '';
      const parity = mode === 'bundle' && booted.includes('tsx') ? '; tsx parity boot ran' : '';
      console.log(`[contract] server boot mode: ${mode} (${why}${built})${parity}`);
    }
    rmSync(dir, { recursive: true, force: true });
  };
}
