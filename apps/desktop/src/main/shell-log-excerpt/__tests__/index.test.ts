import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LOG_EXCERPT_LEN } from '@dorkos/shared/telemetry-events';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import {
  DEFAULT_SHELL_EXCERPT_MAX_AGE_MS,
  DEFAULT_SHELL_EXCERPT_MAX_LINES,
  getShellLogExcerpt,
  registerShellLogExcerptHandler,
  SHELL_LOG_EXCERPT_CHANNEL,
} from '../index';
import { ipcMain, resetElectronMock } from '../../__tests__/electron-mock';
import log, { resetLogMock } from '../../__tests__/electron-log-mock';

/**
 * The shell's own log, tailed for a bug report (DOR-2045).
 *
 * Two incidents nine days apart were diagnosed only because a person opened
 * `main.log` by hand. What is under test is the filter that makes the file
 * worth attaching: the server child's forwarded output is 78% of it and already
 * travels in the same report as `serverLogExcerpt`, while the lines that name
 * the cause are at `info` — so a warn-and-above filter, which is what the
 * server's own excerpt uses, would return the wrong 20%.
 *
 * The log file is REAL here (a temp file the transport double points at), so the
 * bounded tail read, the rotation fold-in and the parse all run for real. Only
 * `electron` and `electron-log` are doubled.
 */

/** A directory holding this test's `main.log`, fresh per test. */
let logDir: string;

/** `YYYY-MM-DD HH:MM:SS.mmm` in LOCAL time — electron-log's own file format. */
function stamp(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.` +
    `${pad(at.getMilliseconds(), 3)}`
  );
}

/** One electron-log file line, written `agoMs` before now. */
function line(level: string, text: string, agoMs = 0): string {
  return `[${stamp(new Date(Date.now() - agoMs))}] [${level}]  ${text}`;
}

/** Write `lines` as the live `main.log` and point the transport double at it. */
function writeLiveLog(lines: string[]): string {
  const path = join(logDir, 'main.log');
  writeFileSync(path, `${lines.join('\n')}\n`);
  log.transports.file.getFile = () => ({ path });
  return path;
}

/** Write `lines` as the rotated sibling electron-log leaves behind at 1 MiB. */
function writeRotatedLog(lines: string[]): void {
  writeFileSync(join(logDir, 'main.old.log'), `${lines.join('\n')}\n`);
}

beforeEach(() => {
  resetElectronMock();
  resetLogMock();
  logDir = mkdtempSync(join(tmpdir(), 'dorkos-shell-log-'));
});

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe('getShellLogExcerpt', () => {
  it("drops the server child's forwarded output", () => {
    writeLiveLog([
      line('error', '[server] Error: ECONNREFUSED /Users/kai/.dork/db.sqlite'),
      line('info', '[renderer] A new page started loading.'),
      line('error', '[server] at Object.<anonymous> (server.js:1:1)'),
    ]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).toContain('[renderer] A new page started loading.');
    expect(excerpt).not.toContain('[server]');
    expect(excerpt).not.toContain('ECONNREFUSED');
  });

  it("keeps the shell's own info-level lines", () => {
    writeLiveLog([
      line('info', '[renderer] Reloading the window.'),
      line('debug', '[renderer] Something too quiet to report.'),
      line('verbose', '[renderer] Quieter still.'),
      line('warn', '[updater] Could not reach the update feed.'),
    ]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).toContain('[renderer] Reloading the window.');
    expect(excerpt).toContain('[updater] Could not reach the update feed.');
    // The level floor: below `info` is noise a report should not carry.
    expect(excerpt).not.toContain('too quiet to report');
    expect(excerpt).not.toContain('Quieter still');
  });

  it('keeps a stack trace with the entry it belongs to', () => {
    writeLiveLog([
      line('error', '[renderer] Could not load the fallback page.'),
      '    at loadFallback (main.js:10:5)',
      '    at onDeadlineExpired (main.js:20:7)',
      line('info', '[renderer] The window came back.'),
    ]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).toContain('at loadFallback (main.js:10:5)');
    expect(excerpt).toContain('at onDeadlineExpired (main.js:20:7)');
    // Attached to the entry above it, not floating after the newer one.
    const frameAt = excerpt?.indexOf('at loadFallback') ?? -1;
    const nextEntryAt = excerpt?.indexOf('The window came back') ?? -1;
    expect(frameAt).toBeGreaterThan(-1);
    expect(frameAt).toBeLessThan(nextEntryAt);
  });

  it('keeps only the newest entries once past the line cap', () => {
    // The cap is exercised at 10 rather than at its default of 200 because 200
    // entries of any real length exceed MAX_LOG_EXCERPT_LEN, and the length
    // bound would be what decided the result — a test of the wrong mechanism.
    // The default itself is a number, exported and read by the callers; what
    // needs proving is that the cap keeps the NEWEST end.
    expect(DEFAULT_SHELL_EXCERPT_MAX_LINES).toBe(200);
    writeLiveLog(Array.from({ length: 60 }, (_, i) => line('info', `[renderer] entry ${i}`)));

    const excerpt = getShellLogExcerpt(10);

    expect(excerpt?.split('\n')).toHaveLength(10);
    expect(excerpt).toContain('[renderer] entry 59');
    expect(excerpt).toContain('[renderer] entry 50');
    expect(excerpt).not.toContain('[renderer] entry 49');
  });

  it('drops lines older than the recency window', () => {
    writeLiveLog([
      line('info', '[renderer] ancient history', DEFAULT_SHELL_EXCERPT_MAX_AGE_MS + 60_000),
      line('info', '[renderer] just now', 1_000),
    ]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).toContain('just now');
    expect(excerpt).not.toContain('ancient history');
  });

  it('folds in the rotated file when the live tail is thin', () => {
    writeRotatedLog([line('info', '[renderer] from before the rotation', 60_000)]);
    writeLiveLog([line('info', '[renderer] since the rotation')]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).toContain('from before the rotation');
    expect(excerpt).toContain('since the rotation');
    // Oldest first, so the report reads in the order things happened.
    expect(excerpt?.indexOf('from before the rotation')).toBeLessThan(
      excerpt?.indexOf('since the rotation') ?? -1
    );
  });

  it('scrubs home directories and secret-shaped tokens', () => {
    writeLiveLog([
      line('warn', '[renderer] Could not read /Users/kai/Library/Logs/@dorkos/desktop/main.log'),
      line('warn', '[updater] Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'),
    ]);

    const excerpt = getShellLogExcerpt();

    expect(excerpt).not.toContain('/Users/kai');
    expect(excerpt).toContain('~/Library/Logs');
    expect(excerpt).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('cuts from the front when it exceeds the length bound', () => {
    const filler = 'x'.repeat(400);
    const lines = Array.from({ length: 60 }, (_, i) => line('info', `[renderer] ${i} ${filler}`));
    writeLiveLog(lines);

    const excerpt = getShellLogExcerpt();

    expect(excerpt?.length).toBeLessThanOrEqual(MAX_LOG_EXCERPT_LEN);
    expect(excerpt?.startsWith('…')).toBe(true);
    // A report is filed about the moment at the END of the log, so the newest
    // line is the one that must survive the cut (DOR-1976).
    expect(excerpt).toContain('[renderer] 59 ');
    expect(excerpt).not.toContain('[renderer] 0 ');
  });

  it('returns undefined rather than throwing when the log file is unreadable', () => {
    log.transports.file.getFile = () => ({ path: join(logDir, 'nothing-here', 'main.log') });

    expect(getShellLogExcerpt()).toBeUndefined();
  });

  it('returns undefined when nothing survives the filter', () => {
    writeLiveLog([
      line('error', '[server] Only the child said anything.'),
      line('debug', '[renderer] And this is below the floor.'),
    ]);

    expect(getShellLogExcerpt()).toBeUndefined();
  });

  it('returns undefined rather than throwing when the transport has no file', () => {
    log.transports.file.getFile = () => {
      throw new Error('file logging is off');
    };

    expect(getShellLogExcerpt()).toBeUndefined();
  });
});

describe('registerShellLogExcerptHandler', () => {
  /** The app's own origin in these tests. */
  const OWN_ORIGIN = 'http://localhost:4242';

  /** An invoke from a page on `url`. */
  function senderOn(url: string): Electron.IpcMainInvokeEvent {
    return { sender: { getURL: () => url } } as unknown as Electron.IpcMainInvokeEvent;
  }

  /** Register the handler and hand back a way to call it. */
  function armHandler(
    getRendererUrl: () => string | undefined = () => OWN_ORIGIN
  ): (url: string) => string | undefined {
    registerShellLogExcerptHandler(getRendererUrl);
    const call = ipcMain.handle.mock.calls.find(([name]) => name === SHELL_LOG_EXCERPT_CHANNEL);
    if (!call) throw new Error(`nothing registered on ${SHELL_LOG_EXCERPT_CHANNEL}`);
    const handler = call[1] as (event: Electron.IpcMainInvokeEvent) => string | undefined;
    return (url: string) => handler(senderOn(url));
  }

  it("answers a page on the app's own origin", () => {
    writeLiveLog([line('info', '[renderer] Reloading the window.')]);

    expect(armHandler()(`${OWN_ORIGIN}/team`)).toContain('Reloading the window.');
  });

  it('refuses a sender that is not one of our own pages', () => {
    writeLiveLog([line('info', '[renderer] Reloading the window.')]);

    expect(armHandler()('https://example.com/phish')).toBeUndefined();
  });

  it('answers undefined rather than throwing when the sender is being torn down', () => {
    writeLiveLog([line('info', '[renderer] Reloading the window.')]);
    registerShellLogExcerptHandler(() => OWN_ORIGIN);
    const call = ipcMain.handle.mock.calls.find(([name]) => name === SHELL_LOG_EXCERPT_CHANNEL);
    const handler = call?.[1] as (event: Electron.IpcMainInvokeEvent) => string | undefined;
    const dyingSender = {
      sender: {
        getURL: () => {
          throw new Error('Object has been destroyed');
        },
      },
    } as unknown as Electron.IpcMainInvokeEvent;

    expect(handler(dyingSender)).toBeUndefined();
  });
});
