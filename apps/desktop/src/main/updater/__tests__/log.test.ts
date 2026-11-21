import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PathVariables } from 'electron-log';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import log, { updaterLogDouble } from '../../__tests__/electron-log-mock';
import { app, resetElectronMock } from '../../__tests__/electron-mock';

/**
 * The updater's own log file (DOR-4847): a logger apart from `main.log`, writing
 * into the data directory's `logs/` folder beside the server's `dorkos.log`.
 */
describe('updater log', () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it('is a logger of its own, not the main one', async () => {
    const { updaterLog } = await import('../log');

    expect(log.create).toHaveBeenCalledWith({ logId: 'updater' });
    expect(updaterLog).toBe(updaterLogDouble);
    expect(updaterLog).not.toBe(log);
  });

  it('writes to logs/updater.log in the packaged data directory', async () => {
    app.isPackaged = true;
    app.getPath = vi.fn(() => '/Users/someone');
    const { updaterLog } = await import('../log');

    expect(updaterLog.transports.file.resolvePathFn({} as PathVariables)).toBe(
      '/Users/someone/.dork/logs/updater.log'
    );
  });

  it('follows the data directory when it changes after import', async () => {
    // Resolved per line, not at import: the module loads before the app is ready.
    const { updaterLog } = await import('../log');
    app.isPackaged = false;
    vi.stubEnv('DORK_HOME', '/tmp/a-dev-home');

    expect(updaterLog.transports.file.resolvePathFn({} as PathVariables)).toBe(
      '/tmp/a-dev-home/logs/updater.log'
    );
    vi.unstubAllEnvs();
  });
});
