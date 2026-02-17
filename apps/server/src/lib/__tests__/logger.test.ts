import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

// Mock the synchronous fs module so tests don't touch the real filesystem
vi.mock('fs');

const LOG_DIR = path.join(os.homedir(), '.dork', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dorkos.log');

describe('logger module', () => {
  let fs: typeof import('fs');
  let loggerModule: typeof import('../logger.js');

  beforeEach(async () => {
    // Reset module state between tests so the logger singleton is fresh
    vi.resetModules();
    vi.clearAllMocks();

    fs = await import('fs');
    loggerModule = await import('../logger.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Default logger (before initLogger)
  // ---------------------------------------------------------------------------
  describe('default logger', () => {
    it('exports a logger that works without initLogger() being called', () => {
      const { logger } = loggerModule;
      // Should be a valid consola instance with log methods
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('default logger does not crash when called', () => {
      const { logger } = loggerModule;
      expect(() => logger.info('test message')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // initLogger
  // ---------------------------------------------------------------------------
  describe('initLogger', () => {
    it('creates log directory if it does not exist', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger();

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(LOG_DIR, { recursive: true });
    });

    it('sets log level from options', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger({ level: 5 });

      const { logger } = loggerModule;
      expect(logger.level).toBe(5);
    });

    it('defaults to level 4 (debug) in non-production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger();

      const { logger } = loggerModule;
      expect(logger.level).toBe(4);

      process.env.NODE_ENV = originalEnv;
    });

    it('defaults to level 3 (info) in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger();

      const { logger } = loggerModule;
      expect(logger.level).toBe(3);

      process.env.NODE_ENV = originalEnv;
    });

    it('adds a file reporter after initialization', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger();

      // The file reporter should write to LOG_FILE on log calls
      const { logger } = loggerModule;
      logger.info('test log entry');

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled();
    });
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
      loggerModule.initLogger({ level: 5 });

      const { logger } = loggerModule;
      logger.info('hello world');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [filePath, content] = calls[0] as [string, string];
      expect(filePath).toBe(LOG_FILE);

      const parsed = JSON.parse(content.trim());
      expect(parsed).toMatchObject({
        level: expect.any(String),
        time: expect.any(String),
        msg: expect.any(String),
      });
    });

    it('writes each log entry on its own line', () => {
      loggerModule.initLogger({ level: 5 });

      const { logger } = loggerModule;
      logger.info('first');
      logger.info('second');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      // Each call should end with a newline
      for (const [, content] of calls) {
        expect(String(content)).toMatch(/\n$/);
      }
    });

    it('includes a valid ISO timestamp in log entries', () => {
      loggerModule.initLogger({ level: 5 });

      const { logger } = loggerModule;
      logger.warn('timestamp test');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [, content] = calls[0] as [string, string];
      const parsed = JSON.parse(content.trim());
      expect(() => new Date(parsed.time)).not.toThrow();
      expect(new Date(parsed.time).toISOString()).toBe(parsed.time);
    });
  });

  // ---------------------------------------------------------------------------
  // Log rotation
  // ---------------------------------------------------------------------------
  describe('log rotation', () => {
    it('rotates the log file when it exceeds 10MB', () => {
      const tenMbPlusOne = 10 * 1024 * 1024 + 1;
      vi.mocked(fs.statSync).mockReturnValue({ size: tenMbPlusOne } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      loggerModule.initLogger();

      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        LOG_FILE,
        expect.stringMatching(/dorkos-\d{4}-\d{2}-\d{2}-\d+\.log$/)
      );
    });

    it('does NOT rotate when file is under 10MB', () => {
      const underTenMb = 10 * 1024 * 1024 - 1;
      vi.mocked(fs.statSync).mockReturnValue({ size: underTenMb } as ReturnType<typeof fs.statSync>);

      loggerModule.initLogger();

      expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    });

    it('cleans up old rotated files beyond MAX_LOG_FILES (7)', () => {
      const tenMbPlusOne = 10 * 1024 * 1024 + 1;
      vi.mocked(fs.statSync).mockReturnValue({ size: tenMbPlusOne } as ReturnType<typeof fs.statSync>);

      // Simulate 9 existing rotated files (beyond the limit of 7)
      const rotatedFiles = [
        'dorkos-2026-01-01-001.log',
        'dorkos-2026-01-02-002.log',
        'dorkos-2026-01-03-003.log',
        'dorkos-2026-01-04-004.log',
        'dorkos-2026-01-05-005.log',
        'dorkos-2026-01-06-006.log',
        'dorkos-2026-01-07-007.log',
        'dorkos-2026-01-08-008.log',
        'dorkos-2026-01-09-009.log',
      ];
      vi.mocked(fs.readdirSync).mockReturnValue(
        rotatedFiles as unknown as ReturnType<typeof fs.readdirSync>
      );

      loggerModule.initLogger();

      // Should delete the 2 oldest files (sorted reverse, slice beyond 7)
      const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls;
      expect(unlinkCalls).toHaveLength(2);
    });

    it('continues without crashing if log file does not exist (ENOENT on statSync)', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      expect(() => loggerModule.initLogger()).not.toThrow();
    });

    it('continues without crashing if rotation fails unexpectedly', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('Unexpected IO error');
      });

      expect(() => loggerModule.initLogger()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Mock pattern (for reference in other test files)
  // ---------------------------------------------------------------------------
  describe('mock pattern verification', () => {
    it('can be mocked with standard vi.mock pattern', async () => {
      // Verify the module exports match what other tests would mock
      const { logger, initLogger } = loggerModule;
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof initLogger).toBe('function');
    });
  });
});
