import { vi } from 'vitest';

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
const levels = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
};

/**
 * `transports.file.getFile()` is how the real module reports where it is
 * writing; the crash-recovery module uses it for its "Open Logs" affordance.
 */
const log = {
  ...levels,
  transports: { file: { getFile: () => ({ path: '/tmp/dorkos-desktop-test/logs/main.log' }) } },
};

export default log;

/** Reset recorded log calls between tests — call from `beforeEach`. */
export function resetLogMock(): void {
  for (const fn of Object.values(levels)) fn.mockClear();
}
