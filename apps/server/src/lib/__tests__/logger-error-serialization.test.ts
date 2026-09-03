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

      const serialized = JSON.stringify(lines()[0]);
      // The outermost links survive in full…
      expect(serialized).toContain('depth-12');
      expect(serialized).toContain('depth-8');
      // …and the tail collapses to a one-line summary rather than recursing on.
      expect(serialized).not.toContain('depth-0"');
      expect(serialized).toContain('Error: depth-');
    });
  });

  describe('lines that carry no Error', () => {
    it('leaves an ordinary context object exactly as it was', () => {
      loggerModule.logger.info('[Tasks] scheduled', { taskId: 'abc', attempts: 2, ok: true });

      const [entry] = lines();
      expect(entry).toMatchObject({
        msg: '[Tasks] scheduled',
        tag: 'Tasks',
        taskId: 'abc',
        attempts: 2,
        ok: true,
      });
    });
  });
});
