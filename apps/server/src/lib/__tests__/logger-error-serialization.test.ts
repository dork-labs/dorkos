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
    // NDJSON back off disk, so console output proves nothing in this file, and
    // it is not free noise: the clipping DOR-802 added guards what the FILE
    // reporter writes, not what the console reporter prints, so the huge-message
    // case below emitted a single ~2.0 MB line. On STDERR, not stdout —
    // BasicReporter routes anything below level 2 to `options.stderr`, so
    // reproducing this with `> file` and no `2>&1` shows you nothing at all.
    // A GitHub runner serialises on a line that size: it spent ~10.6 minutes on
    // the 621,377 characters that survived the pipe in CI, which is what turned
    // an ordinary 37-minute affected-test run into a 46-minute timeout kill on
    // PR #1486 (DOR-1726). How much of the 2 MB lands varies run to run, because
    // `stream.write()` on a pipe is async and the process exits mid-drain.
    //
    // The console reporter being unclipped at all is a product gap, not a test
    // problem — that is DOR-1728, and fixing it there makes this sink redundant.
    // BasicReporter reads `.columns` off the stream before it writes to it.
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

    it('keeps a subclass under the `name` field existing log lines already carry', () => {
      // Shaped like the repo's Error subclasses: `this.name` is an assignment,
      // which makes it own AND enumerable — so it survived the old spread, and
      // must keep its spelling here.
      class ProvisioningError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ProvisioningError';
        }
      }
      loggerModule.logger.error('[Runtimes] provisioning failed', new ProvisioningError('nope'));

      const [entry] = lines();
      expect(entry.name).toBe('ProvisioningError');
      expect(entry.error).toBe('nope');
      expect(String(entry.stack)).toContain('nope');
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

    it('reaches Errors nested deeper than the top level', () => {
      loggerModule.logger.warn('[Mesh] reconcile failed', {
        workspace: 'demo',
        failures: [{ cause: new Error('inner') }],
      });

      const [entry] = lines();
      expect(entry.workspace).toBe('demo');
      const failures = entry.failures as Array<{ cause: Record<string, unknown> }>;
      expect(failures[0].cause.message).toBe('inner');
      expect(String(failures[0].cause.stack)).toContain('inner');
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

    it('stops descending a long chain instead of following it forever', () => {
      let err = new Error('depth-0');
      for (let i = 1; i <= 12; i++) {
        err = new Error(`depth-${i}`, { cause: err });
      }

      loggerModule.logger.error('[relay] send failed', err);

      const entry = lines()[0];
      expect(entry.error).toBe('depth-12');

      // Five links serialize in full; the sixth is where the budget runs out.
      const c1 = entry.cause as Record<string, unknown>;
      const c2 = c1.cause as Record<string, unknown>;
      const c3 = c2.cause as Record<string, unknown>;
      const c4 = c3.cause as Record<string, unknown>;
      expect([c1.message, c2.message, c3.message, c4.message]).toEqual([
        'depth-11',
        'depth-10',
        'depth-9',
        'depth-8',
      ]);
      // The tail collapses to one exact summary string rather than recursing on.
      expect(c4.cause).toBe('Error: depth-7');
      expect(JSON.stringify(entry)).not.toContain('depth-6');
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

    it('writes the sub-errors of one nested in a context object', () => {
      const aggregate = new AggregateError([new Error('inner')], 'all failed');

      loggerModule.logger.warn('[relay] fan-out failed', { err: aggregate });

      const [entry] = lines();
      const err = entry.err as Record<string, unknown>;
      const subErrors = err.errors as Array<Record<string, unknown>>;
      expect(subErrors[0].message).toBe('inner');
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
      expect(String(entry.error)).toContain('more characters]');
      expect(String(entry.error).length).toBeLessThan(5 * 1024);
      expect(String(entry.stack).length).toBeLessThan(17 * 1024);
      // The head of the message — the part that identifies it — is still there.
      expect(String(entry.error).startsWith('xxxx')).toBe(true);
    });

    it('still writes a line when the context cannot be serialized at all', () => {
      const cyclic: Record<string, unknown> = { workspace: 'demo' };
      cyclic.self = cyclic;

      expect(() => loggerModule.logger.error('[workspaces] GET / failed', cyclic)).not.toThrow();

      const [entry] = lines();
      expect(entry.msg).toBe('[workspaces] GET / failed');
      expect(String(entry.logSerializationError)).toContain('circular');
    });

    it('survives a context property whose getter throws', () => {
      const hostile = {
        get boom(): string {
          throw new Error('getter exploded');
        },
      };

      expect(() => loggerModule.logger.error('[relay] send failed', hostile)).not.toThrow();

      const [entry] = lines();
      expect(entry.msg).toBe('[relay] send failed');
      expect(entry.logSerializationError).toBe('Error: getter exploded');
    });
  });
});
