import { vi, type Mock } from 'vitest';

/**
 * Test double for `electron-log`, mounted via
 * `vi.mock('electron-log', () => import('./electron-log-mock'))`.
 *
 * The real module resolves a log file under the Electron app's userData path
 * and writes to it; in a test that is both a side effect on disk and an
 * un-assertable one. Several supervisor behaviors are *only* observable as a
 * log line — a crash logged while no window is focused, most of all — so the
 * log surface has to be inspectable.
 *
 * `electron-log` is consumed as a default import, so the double is exported
 * as `default`.
 */

/**
 * Where the double claims to be writing.
 *
 * Exported because it is now part of the contract two ways: the "Open Logs"
 * affordance reveals it, and the start-up failure dialogs quote it (see
 * `log-location.ts`). A test that hardcoded the same string would keep passing
 * if this one moved.
 */
export const LOG_DIRECTORY = '/tmp/dorkos-desktop-test/logs';

/** The file inside {@link LOG_DIRECTORY} the double reports. */
const LOG_FILE_PATH = `${LOG_DIRECTORY}/main.log`;

/** A level method. `electron-log` takes anything, like `console`. */
type LogFn = Mock<(...args: unknown[]) => void>;

/** Level names this app logs at. */
const LEVELS = ['info', 'warn', 'error', 'debug', 'verbose'] as const;

/**
 * The slice of `electron-log` the main process actually uses. Written out
 * rather than inferred: an inferred type here names `@vitest/spy` through a
 * pnpm-internal path, which `tsc` rightly refuses to emit as portable.
 */
type ElectronLogMock = Record<(typeof LEVELS)[number], LogFn> & {
  /** How the real module reports where it is writing. */
  transports: { file: { getFile: () => { path: string } } };
};

const log: ElectronLogMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
  transports: { file: { getFile: () => ({ path: LOG_FILE_PATH }) } },
};

export default log;

/** Reset recorded log calls between tests — call from `beforeEach`. */
export function resetLogMock(): void {
  for (const level of LEVELS) log[level].mockClear();
}
