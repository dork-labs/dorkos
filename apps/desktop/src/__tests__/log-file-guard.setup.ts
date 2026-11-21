import { tmpdir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';

/**
 * Keeps every desktop test run out of the real app log (DOR-2042).
 *
 * Most tests mock `electron-log`, but one that forgets would write through the real
 * module, which outside Electron still appends to `~/Library/Logs/@dorkos/desktop/main.log`.
 * Fake failures there bury real entries and mislead whoever reads the log next, including a
 * bug report's log capture. Registered as a setup file in `vitest.config.ts`.
 */

/** Where an unmocked test's log lines land instead. */
const GUARD_DIR = join(tmpdir(), 'dorkos-desktop-vitest');

log.transports.file.resolvePathFn = () => join(GUARD_DIR, 'main.log');

/**
 * The same guard for every logger made with `log.create` — the updater's own log is one
 * (DOR-4847). Its module points its file at the data directory as it is created, so the
 * temp path is pinned here in a way that assignment cannot replace. Patched rather than
 * importing that module: a module this file imports is cached before a test's `vi.mock`
 * can reach it.
 */
const create = log.create.bind(log);
log.create = (options) => {
  const logger = create(options);
  const guarded = () => join(GUARD_DIR, `${options.logId}.log`);
  Object.defineProperty(logger.transports.file, 'resolvePathFn', {
    configurable: true,
    get: () => guarded,
    set: () => {},
  });
  return logger;
};
