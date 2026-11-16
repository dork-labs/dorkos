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
 * A run that is killed never reaches its teardown, so setup first clears
 * folders that crashed or killed runs left behind ({@link clearDeadRuns}).
 *
 * @module http/__tests__/contract/global-setup
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  BUILD_MS_FILE,
  BOOTED_MARKER_PREFIX,
  CONTRACT_BUILD_ROOT,
  isAlive,
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

/** A file in each run folder naming the pid of the Vitest process that owns it. */
const OWNER_FILE = 'owner-pid';

/**
 * How old a run folder with no readable owner must be before setup clears it:
 * only folders from before {@link OWNER_FILE} existed, or from a run killed in
 * the instant between making its folder and naming its owner. No real run
 * would still be inside one, as its owner is written at once.
 */
const UNOWNED_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Remove the `run-*` folders whose run is over but never tore down: those
 * whose owning Vitest process has gone, and, with no owner named, those older
 * than {@link UNOWNED_STALE_MS}. A folder whose owner is alive is kept however
 * old it is, as a `--watch` run keeps its folder for as long as it runs; a
 * concurrent run on this machine is therefore never touched. (A dead owner's
 * pid taken by another process keeps its folder a while longer: the safe way
 * to be wrong.)
 *
 * The owner is the Vitest main process that ran this setup, not the worker
 * pid in the build `lock`: workers come and go within a run, and a run that
 * never built (tsx mode, or no bundle boot yet) has no lock at all.
 */
function clearDeadRuns(): void {
  let entries: string[];
  try {
    entries = readdirSync(CONTRACT_BUILD_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('run-')) continue;
    const dir = path.join(CONTRACT_BUILD_ROOT, name);
    try {
      const owner = Number(readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim() || 'NaN');
      const over =
        Number.isInteger(owner) && owner > 0
          ? !isAlive(owner)
          : Date.now() - statSync(dir).mtimeMs > UNOWNED_STALE_MS;
      if (over) rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // No owner named: judge by age alone. A folder gone already is fine.
      // Anything else unreadable is left alone: setup never fails over a leftover.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      const age = Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > UNOWNED_STALE_MS) rmSync(dir, { recursive: true, force: true });
    }
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
  clearDeadRuns();
  const dir = mkdtempSync(path.join(CONTRACT_BUILD_ROOT, 'run-'));
  writeFileSync(path.join(dir, OWNER_FILE), String(process.pid));
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}
