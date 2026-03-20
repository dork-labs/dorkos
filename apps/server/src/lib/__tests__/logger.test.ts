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
  // initLogger — logDir resolution
  // ---------------------------------------------------------------------------
  describe('initLogger logDir resolution', () => {
    it('uses explicit logDir when provided', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      loggerModule.initLogger({ logDir: '/custom/logs' });

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith('/custom/logs', { recursive: true });
      expect(loggerModule.getLogDir()).toBe('/custom/logs');
    });
  });

  // ---------------------------------------------------------------------------
  // initLogger — log level
  // ---------------------------------------------------------------------------
  describe('initLogger log level', () => {
    beforeEach(() => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    });

    it('sets log level from options', () => {
      loggerModule.initLogger({ level: 5, logDir: '/tmp/test-logs' });
      expect(loggerModule.logger.level).toBe(5);
    });

    it('defaults to level 4 (debug) in non-production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      loggerModule.initLogger({ logDir: '/tmp/test-logs' });
      expect(loggerModule.logger.level).toBe(4);

      process.env.NODE_ENV = originalEnv;
    });

    it('defaults to level 3 (info) in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      loggerModule.initLogger({ logDir: '/tmp/test-logs' });
      expect(loggerModule.logger.level).toBe(3);

      process.env.NODE_ENV = originalEnv;
    });

    it('adds a file reporter after initialization', () => {
      loggerModule.initLogger({ logDir: '/tmp/test-logs' });
      loggerModule.logger.info('test log entry');
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
      loggerModule.initLogger({ level: 5, logDir: '/test/logs' });
      loggerModule.logger.info('hello world');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [filePath, content] = calls[0] as [string, string];
      expect(filePath).toBe('/test/logs/dorkos.log');

      const parsed = JSON.parse(content.trim());
      expect(parsed).toMatchObject({
        level: expect.any(String),
        time: expect.any(String),
        msg: expect.any(String),
      });
    });

    it('writes each log entry on its own line', () => {
      loggerModule.initLogger({ level: 5, logDir: '/tmp/test-logs' });
      loggerModule.logger.info('first');
      loggerModule.logger.info('second');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      for (const [, content] of calls) {
        expect(String(content)).toMatch(/\n$/);
      }
    });

    it('includes a valid ISO timestamp in log entries', () => {
      loggerModule.initLogger({ level: 5, logDir: '/tmp/test-logs' });
      loggerModule.logger.warn('timestamp test');

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
    it('rotates when file is from a previous day', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedDate = yesterday.toISOString().slice(0, 10);

      vi.mocked(fs.statSync).mockReturnValue({
        size: 100,
        mtime: yesterday,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      loggerModule.initLogger({ logDir: '/test/logs' });

      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        '/test/logs/dorkos.log',
        `/test/logs/dorkos.${expectedDate}.log`
      );
    });

    it('uses sequence number when date file already exists', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedDate = yesterday.toISOString().slice(0, 10);

      vi.mocked(fs.statSync).mockReturnValue({
        size: 100,
        mtime: yesterday,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        `dorkos.${expectedDate}.log`,
      ] as unknown as ReturnType<typeof fs.readdirSync>);

      loggerModule.initLogger({ logDir: '/test/logs' });

      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        '/test/logs/dorkos.log',
        `/test/logs/dorkos.${expectedDate}.1.log`
      );
    });

    it('rotates when file exceeds maxLogSize within same day', () => {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);

      vi.mocked(fs.statSync).mockReturnValue({
        size: 600 * 1024, // 600KB, exceeds 500KB default
        mtime: today,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      loggerModule.initLogger({ logDir: '/test/logs' });

      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        '/test/logs/dorkos.log',
        `/test/logs/dorkos.${todayStr}.1.log`
      );
    });

    it('respects custom maxLogSize parameter', () => {
      const today = new Date();

      vi.mocked(fs.statSync).mockReturnValue({
        size: 200 * 1024, // 200KB
        mtime: today,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      // 100KB threshold — should trigger rotation
      loggerModule.initLogger({ logDir: '/test/logs', maxLogSize: 100 * 1024 });

      expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    });

    it('does NOT rotate when file is under maxLogSize and from today', () => {
      vi.mocked(fs.statSync).mockReturnValue({
        size: 100 * 1024, // 100KB, under 500KB default
        mtime: new Date(),
      } as unknown as ReturnType<typeof fs.statSync>);

      loggerModule.initLogger({ logDir: '/test/logs' });

      expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    });

    it('cleans up old rotated files beyond maxLogFiles', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      vi.mocked(fs.statSync).mockReturnValue({
        size: 100,
        mtime: yesterday,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // 16 rotated files, maxLogFiles defaults to 14 — should delete 2
      const rotatedFiles = Array.from({ length: 16 }, (_, i) => {
        const d = String(i + 1).padStart(2, '0');
        return `dorkos.2026-01-${d}.log`;
      });
      vi.mocked(fs.readdirSync).mockReturnValue(
        rotatedFiles as unknown as ReturnType<typeof fs.readdirSync>
      );

      loggerModule.initLogger({ logDir: '/test/logs' });

      const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls;
      expect(unlinkCalls).toHaveLength(2);
    });

    it('respects custom maxLogFiles parameter', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      vi.mocked(fs.statSync).mockReturnValue({
        size: 100,
        mtime: yesterday,
      } as unknown as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // 5 rotated files, maxLogFiles=3 — should delete 2
      const rotatedFiles = Array.from({ length: 5 }, (_, i) => {
        const d = String(i + 1).padStart(2, '0');
        return `dorkos.2026-01-${d}.log`;
      });
      vi.mocked(fs.readdirSync).mockReturnValue(
        rotatedFiles as unknown as ReturnType<typeof fs.readdirSync>
      );

      loggerModule.initLogger({ logDir: '/test/logs', maxLogFiles: 3 });

      const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls;
      expect(unlinkCalls).toHaveLength(2);
    });

    it('continues without crashing if log file does not exist (ENOENT)', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(() => loggerModule.initLogger({ logDir: '/tmp/test-logs' })).not.toThrow();
    });

    it('continues without crashing if rotation fails unexpectedly', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('Unexpected IO error');
      });
      expect(() => loggerModule.initLogger({ logDir: '/tmp/test-logs' })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // getLogDir
  // ---------------------------------------------------------------------------
  describe('getLogDir', () => {
    it('returns undefined before initLogger is called', () => {
      expect(loggerModule.getLogDir()).toBeUndefined();
    });

    it('returns the resolved log directory after initLogger', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      loggerModule.initLogger({ logDir: '/my/logs' });
      expect(loggerModule.getLogDir()).toBe('/my/logs');
    });
  });

  // ---------------------------------------------------------------------------
  // createTaggedLogger
  // ---------------------------------------------------------------------------
  describe('createTaggedLogger', () => {
    it('returns a logger with the specified tag', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      loggerModule.initLogger({ level: 5, logDir: '/test/logs' });

      const tagged = loggerModule.createTaggedLogger('Pulse');
      tagged.info('scheduler started');

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [, content] = calls[0] as [string, string];
      const parsed = JSON.parse(content.trim());
      expect(parsed.tag).toBe('Pulse');
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

    it('converts non-Error values to string', () => {
      expect(loggerModule.logError('string error')).toEqual({ error: 'string error' });
      expect(loggerModule.logError(42)).toEqual({ error: '42' });
      expect(loggerModule.logError(null)).toEqual({ error: 'null' });
    });
  });

  // ---------------------------------------------------------------------------
  // Mock pattern (for reference in other test files)
  // ---------------------------------------------------------------------------
  describe('mock pattern verification', () => {
    it('can be mocked with standard vi.mock pattern', async () => {
      const { logger, initLogger, getLogDir, createTaggedLogger, logError } = loggerModule;
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof initLogger).toBe('function');
      expect(typeof getLogDir).toBe('function');
      expect(typeof createTaggedLogger).toBe('function');
      expect(typeof logError).toBe('function');
    });
  });
});
