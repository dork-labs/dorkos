import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The log file is written through a handle kept open, and rotated as lines are
 * written rather than only at startup (DOR-2902). A server that stayed up used
 * to grow one file without limit; one reached 53 MB.
 */
describe('logger rotation while running', () => {
  let dir: string;
  let loggerModule: typeof import('../logger.js');

  const logFiles = () =>
    fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('dorkos'))
      .sort();
  const lines = (file: string) =>
    fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg: string });

  beforeEach(async () => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-rotation-'));
    loggerModule = await import('../logger.js');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Re-init into a fresh dir closes the handle on this one.
    const closed = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-closed-'));
    loggerModule.initLogger({ logDir: closed });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(closed, { recursive: true, force: true });
  });

  it('writes every line, in order, to dorkos.log', () => {
    loggerModule.initLogger({ logDir: dir, level: 3 });
    for (let i = 0; i < 20; i++) loggerModule.logger.info(`line ${i}`);
    expect(lines('dorkos.log').map((l) => l.msg)).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${i}`)
    );
  });

  it('rotates when the file outgrows its size, without a restart', () => {
    loggerModule.initLogger({ logDir: dir, level: 3, maxLogSize: 2_000 });
    for (let i = 0; i < 100; i++) loggerModule.logger.info(`line ${i} ${'x'.repeat(50)}`);

    const files = logFiles();
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      // A file passes the size by at most the one line that crossed it.
      expect(fs.statSync(path.join(dir, file)).size).toBeLessThan(2_200);
    }
    const all = files
      .filter((f) => f !== 'dorkos.log')
      .concat('dorkos.log')
      .flatMap((f) => lines(f).map((l) => l.msg));
    expect(new Set(all).size).toBe(100);
  });

  it('starts a new file when the day turns', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T23:59:00Z'));
    loggerModule.initLogger({ logDir: dir, level: 3 });
    loggerModule.logger.info('before midnight');
    // The file carries the time its last line was written.
    fs.utimesSync(
      path.join(dir, 'dorkos.log'),
      new Date('2026-10-13T23:59:00Z'),
      new Date('2026-10-13T23:59:00Z')
    );

    vi.setSystemTime(new Date('2026-10-14T00:01:00Z'));
    loggerModule.logger.info('after midnight');

    expect(lines('dorkos.2026-10-13.log').map((l) => l.msg)).toEqual(['before midnight']);
    expect(lines('dorkos.log').map((l) => l.msg)).toEqual(['after midnight']);
  });

  it('keeps the newest files once a day has passed ten rotations', () => {
    // As text, `.10.log` sorts before `.9.log`; the newest were being deleted.
    loggerModule.initLogger({ logDir: dir, level: 3, maxLogSize: 300, maxLogFiles: 14 });
    for (let i = 0; i < 400; i++) loggerModule.logger.info(`line ${i} ${'x'.repeat(40)}`);

    const all = logFiles()
      .filter((f) => f !== 'dorkos.log')
      .flatMap((f) => lines(f).map((l) => l.msg));
    // Nothing was deleted: one day, far under the size cap.
    expect(new Set([...all, ...lines('dorkos.log').map((l) => l.msg)]).size).toBe(400);
    expect(logFiles().some((f) => /\.\d{2,}\.log$/.test(f))).toBe(true);
  });

  it('deletes the oldest rotations first when the total is over its size', () => {
    // As text, `.10.log` sorts before `.9.log`, which made the newest go first.
    loggerModule.initLogger({
      logDir: dir,
      level: 3,
      maxLogSize: 300,
      maxRotatedLogBytes: 1_500,
    });
    for (let i = 0; i < 400; i++) loggerModule.logger.info(`line ${i}`);

    const kept = logFiles()
      .filter((f) => f !== 'dorkos.log')
      .flatMap((f) => lines(f).map((l) => Number(l.msg.split(' ')[1])));
    // What survives is the newest run of lines, right up to the open file,
    // with nothing missing inside it.
    const newest = Math.max(...kept);
    const current = Number(lines('dorkos.log')[0]!.msg.split(' ')[1]);
    expect(newest).toBe(current - 1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.sort((a, b) => a - b)).toEqual(
      Array.from({ length: kept.length }, (_, i) => newest - kept.length + 1 + i)
    );
  });

  it("treats a day's undated file as that day's newest when the total is over", () => {
    // `dorkos.D.log` is renamed at midnight, after D's size rotations.
    for (const name of ['dorkos.2026-10-01.1.log', 'dorkos.2026-10-01.log']) {
      fs.writeFileSync(path.join(dir, name), 'x'.repeat(400));
    }
    fs.writeFileSync(path.join(dir, 'dorkos.log'), 'x'.repeat(1_000));
    loggerModule.initLogger({ logDir: dir, maxLogSize: 500, maxRotatedLogBytes: 1_500 });

    // The 1,000-byte file rotated today takes most of the room; of 10-01, the
    // end-of-day file survives and its earlier part goes.
    expect(fs.existsSync(path.join(dir, 'dorkos.2026-10-01.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dorkos.2026-10-01.1.log'))).toBe(false);
  });

  it('keeps only the newest days of rotated logs', () => {
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      fs.writeFileSync(path.join(dir, `dorkos.${day}.log`), '{}\n');
      fs.writeFileSync(path.join(dir, `dorkos.${day}.1.log`), '{}\n');
    }
    fs.writeFileSync(path.join(dir, 'dorkos.log'), 'x'.repeat(1_000));
    loggerModule.initLogger({ logDir: dir, level: 3, maxLogSize: 500, maxLogFiles: 2 });

    const days = new Set(
      logFiles().flatMap((f) => /dorkos\.(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] ?? [])
    );
    expect([...days].sort()).toEqual(
      [
        new Date().toISOString().slice(0, 10) > '2026-10-04' ? '2026-10-04' : '2026-10-03',
        new Date().toISOString().slice(0, 10),
      ].sort()
    );
  });

  it('retries a failed rotation only after another full size, not on every line', () => {
    loggerModule.initLogger({ logDir: dir, level: 3, maxLogSize: 500 });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    for (let i = 0; i < 100; i++) loggerModule.logger.info(`line ${i} ${'x'.repeat(40)}`);

    // About 6 KB written: a retry per line would be ~90 attempts.
    expect(rename.mock.calls.length).toBeLessThan(30);
    expect(lines('dorkos.log')).toHaveLength(100);
  });

  it('reopens the file when somebody deletes it', () => {
    loggerModule.initLogger({ logDir: dir, level: 3 });
    loggerModule.logger.info('first');
    fs.rmSync(path.join(dir, 'dorkos.log'));
    for (let i = 0; i < 600; i++) loggerModule.logger.info(`after ${i}`);

    expect(fs.existsSync(path.join(dir, 'dorkos.log'))).toBe(true);
    expect(lines('dorkos.log').at(-1)?.msg).toBe('after 599');
  });
});
