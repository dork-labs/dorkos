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
log.transports.file.resolvePathFn = () => join(tmpdir(), 'dorkos-desktop-vitest', 'main.log');
