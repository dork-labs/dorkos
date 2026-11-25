import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the synchronous fs module so tests don't touch the real filesystem
vi.mock('fs');

describe('logger module', () => {
  let fs: typeof import('fs');
  let loggerModule: typeof import('../logger.js');

  beforeEach(async () => {
    // Reset module state between tests so the logger singleton is fresh
    vi.resetModules();
    vi.clearAllMocks();

    fs = await import('fs');
    // The file reporter writes through a handle it keeps open (DOR-2902).
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({ size: 0, ino: 1 } as never);
    loggerModule = await import('../logger.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // File reporter — NDJSON output
  // ---------------------------------------------------------------------------
  describe('file reporter', () => {
    beforeEach(() => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    });

    it('writes NDJSON lines to the log file', () => {
      loggerModule.initLogger({ level: 5, logDir: '/test/logs' });
      loggerModule.logger.info('hello world');

      const calls = vi.mocked(fs.writeSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [fd, content] = calls[0] as unknown as [number, string];
      expect(fd).toBe(42);
      expect(vi.mocked(fs.openSync)).toHaveBeenCalledWith('/test/logs/dorkos.log', 'a');

      const parsed = JSON.parse(content.trim());
      expect(parsed).toMatchObject({
        level: expect.any(String),
        time: expect.any(String),
        msg: expect.any(String),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // logError
  // ---------------------------------------------------------------------------
  describe('logError', () => {
    it('extracts message and stack from Error instances', () => {
      const err = new Error('test error');
      const result = loggerModule.logError(err);
      expect(result.error).toBe('test error');
      expect(result.stack).toBeDefined();
    });

    /**
     * ~92 call sites fold this return value into a wider log context, so the
     * clipping added for the runaway case (DOR-1827) may not change a single
     * byte of the ordinary one — which is every error the server actually logs.
     */
    it('returns an ordinary error’s own message and stack strings, unchanged', () => {
      const err = new Error('ENOENT: no such file or directory');

      const result = loggerModule.logError(err);

      expect(result.error).toBe(err.message);
      expect(result.stack).toBe(err.stack);
      expect(result.error).not.toContain('[truncated');
      expect(result.stack).not.toContain('[truncated');
    });

    /**
     * Totality. Every one of these call sites is inside a `catch`, and the
     * call happens at the CALL SITE — outside the logger, so outside the
     * try/catch the reporters run under. A throw here does not lose a log
     * line, it replaces the failure being reported with one of its own, in
     * the middle of a recovery path. Reading a field off a malformed error is
     * exactly where that risk lives: an `Error` whose `message` was reassigned
     * to a non-string has no `.length` and no `.slice`, and a hostile one
     * throws on the property read itself.
     *
     * `packages/relay/src/lib/describe-error.ts` states the same rule for the
     * same reason, down to the sentinel this returns.
     */
    describe('malformed errors it must survive rather than report', () => {
      it('survives a message getter that throws, without losing the line', () => {
        const err = new Error('unused');
        Object.defineProperty(err, 'message', {
          get(): string {
            throw new Error('getter exploded');
          },
          configurable: true,
        });

        expect(() => loggerModule.logError(err)).not.toThrow();
        // The same sentinel `describeError` collapses to, for the same reason.
        expect(loggerModule.logError(err)).toEqual({ error: 'unserializable error' });
      });
    });
  });
});
