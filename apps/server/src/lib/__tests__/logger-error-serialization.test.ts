import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The defect this file pins (DOR-802) lived in the bytes the file reporter
 * writes, so nothing here is mocked: the logger is initialized against a real
 * temp directory and every assertion reads the NDJSON back off disk.
 */
describe('NDJSON error serialization', () => {
  let logDir: string;
  let loggerModule: typeof import('../logger.js');

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-logger-test-'));
    vi.resetModules();
    loggerModule = await import('../logger.js');
    loggerModule.initLogger({ level: 5, logDir });

    // Point consola's CONSOLE reporter at a sink, leaving the file reporter —
    // the thing actually under test — alone. Every assertion here reads the
    // NDJSON back off disk, so console output proves nothing in this file.
    //
    // This sink is now only about keeping test runs quiet. It used to be load
    // bearing: the clipping DOR-802 added guarded what the FILE reporter wrote
    // and not what the console reporter printed, so the huge-message case below
    // emitted a single ~2.0 MB line, and a GitHub runner spent ~10.6 minutes
    // serializing it — an ordinary 37-minute affected-test run became a
    // 46-minute timeout kill on PR #1486 (DOR-1726). The console reporter clips
    // on its own since DOR-1728, so removing this sink would cost noise, not a
    // timeout. BasicReporter reads `.columns` off the stream before writing to
    // it, and routes anything below level 2 to `options.stderr`.
    const sink = { columns: 80, write: () => true } as unknown as NodeJS.WriteStream;
    loggerModule.logger.options.stdout = sink;
    loggerModule.logger.options.stderr = sink;
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** Every NDJSON line written so far, parsed. */
  function lines(): Record<string, unknown>[] {
    const raw = fs.readFileSync(path.join(logDir, 'dorkos.log'), 'utf8');
    return raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  describe('an Error passed as the context argument', () => {
    it('writes the message and stack, which spreading an Error drops', () => {
      loggerModule.logger.error('[Extensions] Failed to initialize', new Error('boom'));

      const [entry] = lines();
      expect(entry.msg).toBe('[Extensions] Failed to initialize');
      expect(entry.error).toBe('boom');
      expect(entry.name).toBe('Error');
      expect(String(entry.stack)).toContain('boom');
    });

    it('keeps the errno fields it already wrote, and adds the reason', () => {
      const emfile = Object.assign(
        new Error("EMFILE: too many open files, scandir '/Users/x/code'"),
        { errno: -24, code: 'EMFILE', syscall: 'scandir', path: '/Users/x/code' }
      );

      loggerModule.logger.error('[Watcher] watch failed', emfile);

      const [entry] = lines();
      // Line shape that existing readers already depend on
      expect(entry.errno).toBe(-24);
      expect(entry.code).toBe('EMFILE');
      expect(entry.syscall).toBe('scandir');
      expect(entry.path).toBe('/Users/x/code');
      // The part that used to be dropped
      expect(entry.error).toBe("EMFILE: too many open files, scandir '/Users/x/code'");
      expect(String(entry.stack)).toContain('EMFILE');
    });
  });

  describe('an Error nested in the context object', () => {
    it('serializes the `{ err }` wrapper the routes use', () => {
      loggerModule.logger.error('[workspaces] GET / failed', { err: new Error('disk gone') });

      const [entry] = lines();
      const err = entry.err as Record<string, unknown>;
      expect(err.message).toBe('disk gone');
      expect(err.name).toBe('Error');
      expect(String(err.stack)).toContain('disk gone');
    });
  });

  describe('cause chains', () => {
    it('follows a cause chain of Errors', () => {
      const root = new Error('socket closed');
      const wrapped = new Error('request failed', { cause: root });

      loggerModule.logger.error('[relay] send failed', wrapped);

      const [entry] = lines();
      expect(entry.error).toBe('request failed');
      const cause = entry.cause as Record<string, unknown>;
      expect(cause.message).toBe('socket closed');
      expect(String(cause.stack)).toContain('socket closed');
    });
  });

  describe('AggregateError', () => {
    it('writes the sub-errors, which are non-enumerable exactly like `stack`', () => {
      const aggregate = new AggregateError(
        [new Error('endpoint A refused'), new Error('endpoint B timed out')],
        'every endpoint failed'
      );

      loggerModule.logger.error('[mesh] discovery failed', aggregate);

      const [entry] = lines();
      expect(entry.error).toBe('every endpoint failed');
      const subErrors = entry.errors as Array<Record<string, unknown>>;
      expect(subErrors.map((e) => e.message)).toEqual([
        'endpoint A refused',
        'endpoint B timed out',
      ]);
      expect(String(subErrors[0].stack)).toContain('endpoint A refused');
    });
  });

  describe('lines that carry no Error', () => {
    it('leaves an ordinary context object exactly as it was', () => {
      loggerModule.logger.info('[Tasks] scheduled', { taskId: 'abc', attempts: 2, ok: true });

      const [entry] = lines();
      // toEqual, not toMatchObject: a subset match would pass just as happily if
      // the reporter started adding fields nobody asked for.
      expect(entry).toEqual({
        level: 'info',
        time: expect.any(String) as unknown as string,
        msg: '[Tasks] scheduled',
        tag: 'Tasks',
        taskId: 'abc',
        attempts: 2,
        ok: true,
      });
    });
  });

  describe('lines that would otherwise be unbounded', () => {
    it('clips a huge message and stack instead of writing a megabyte-long line', () => {
      const huge = new Error('x'.repeat(2_000_000));

      loggerModule.logger.error('[Runtimes] subprocess died', huge);

      const raw = fs.readFileSync(path.join(logDir, 'dorkos.log'), 'utf8');
      expect(raw.length).toBeLessThan(64 * 1024);

      const [entry] = lines();
      // The marker names the whole length, not the dropped remainder.
      expect(String(entry.error)).toContain('[truncated, 2000000 characters total]');
      expect(String(entry.error).length).toBeLessThan(5 * 1024);
      expect(String(entry.stack).length).toBeLessThan(17 * 1024);
      // The head of the message — the part that identifies it — is still there.
      expect(String(entry.error).startsWith('xxxx')).toBe(true);
    });
  });
});
