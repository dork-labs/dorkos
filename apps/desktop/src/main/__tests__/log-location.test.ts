import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { describeLogLocation } from '../log-location';
import { app, resetElectronMock } from './electron-mock';
import log, { resetLogMock } from './electron-log-mock';

/**
 * The sentence at the end of every "DorkOS couldn't start" box.
 *
 * It used to be a macOS path literal, which on Windows sent people to a
 * directory that does not exist on their machine — in the one dialog they were
 * already stuck at. What replaced it is a derivation, so what is worth testing
 * is that it derives rather than guesses, and that it still answers when the
 * thing it asks has fallen over. A dialog builder that throws replaces a
 * diagnosis with a crash.
 */
describe('describeLogLocation', () => {
  beforeEach(() => {
    resetElectronMock();
    resetLogMock();
  });

  it('names the directory the log file is actually in', () => {
    log.transports.file.getFile = () => ({
      path: '/Users/kai/Library/Logs/@dorkos/desktop/main.log',
    });

    expect(describeLogLocation()).toBe('/Users/kai/Library/Logs/@dorkos/desktop');
  });

  /**
   * The Windows bug this module exists for, tested as far as it can be from a
   * POSIX host: the answer is whatever directory the transport reports, and
   * nothing in the module contributes a path shape of its own. The Windows
   * *spelling* is then Node's own `dirname` on Windows — which is precisely
   * why there is no `process.platform` branch here to test.
   */
  it("echoes the transport's directory rather than a shape of its own", () => {
    log.transports.file.getFile = () => ({ path: '/srv/dork-data/logs/main.log' });

    expect(describeLogLocation()).toBe('/srv/dork-data/logs');
    expect(describeLogLocation()).not.toContain('Library');
  });

  it('falls back to the path Electron would have used when the transport has no file', () => {
    log.transports.file.getFile = () => {
      throw new Error('file logging is off');
    };
    app.getPath = vi.fn((name?: string) => (name === 'logs' ? '/var/log/dorkos' : '/tmp'));

    expect(describeLogLocation()).toBe('/var/log/dorkos');
  });

  it('says something a person can read rather than throwing when nothing will answer', () => {
    log.transports.file.getFile = () => {
      throw new Error('file logging is off');
    };
    app.getPath = vi.fn(() => {
      throw new Error('no such path name');
    });

    // Built to be pasted into a sentence, so it has to read as one.
    expect(describeLogLocation()).toBe("DorkOS's log folder");
  });
});
