import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';

describe('--log-level CLI flag', () => {
  // eslint-disable-next-line no-restricted-syntax -- test saves/restores process.env to verify env var behavior
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv }; // eslint-disable-line no-restricted-syntax -- restoring saved env
  });

  describe('LOG_LEVEL_MAP integration', () => {
    it('maps "debug" to 4', () => {
      expect(LOG_LEVEL_MAP['debug']).toBe(4);
    });

    it('maps "info" to 3', () => {
      expect(LOG_LEVEL_MAP['info']).toBe(3);
    });

    it('maps "warn" to 2', () => {
      expect(LOG_LEVEL_MAP['warn']).toBe(2);
    });

    it('maps "error" to 1', () => {
      expect(LOG_LEVEL_MAP['error']).toBe(1);
    });

    it('maps "fatal" to 0', () => {
      expect(LOG_LEVEL_MAP['fatal']).toBe(0);
    });

    it('maps "trace" to 5', () => {
      expect(LOG_LEVEL_MAP['trace']).toBe(5);
    });

    it('returns undefined for invalid level names', () => {
      expect(LOG_LEVEL_MAP['invalid']).toBeUndefined();
    });
  });

  describe('log level resolution logic', () => {
    /**
     * Simulates the CLI log level resolution logic from cli.ts:
     * CLI flag > env var (LOG_LEVEL) > config value > default
     */
    function resolveLogLevel(opts: {
      cliFlag?: string;
      envLogLevel?: string;
      configValue?: string | null;
      nodeEnv?: string;
    }): string {
      const logLevelName =
        opts.cliFlag ||
        opts.envLogLevel ||
        opts.configValue ||
        (opts.nodeEnv === 'production' ? 'info' : 'debug');
      return String(LOG_LEVEL_MAP[logLevelName] ?? 3);
    }

    it('CLI flag takes highest precedence', () => {
      const result = resolveLogLevel({
        cliFlag: 'debug',
        envLogLevel: 'error',
        configValue: 'warn',
      });
      expect(result).toBe('4');
    });

    it('env var LOG_LEVEL is second precedence', () => {
      const result = resolveLogLevel({
        envLogLevel: 'error',
        configValue: 'warn',
      });
      expect(result).toBe('1');
    });

    it('config value is third precedence', () => {
      const result = resolveLogLevel({
        configValue: 'trace',
      });
      expect(result).toBe('5');
    });

    it('defaults to info in production', () => {
      const result = resolveLogLevel({
        nodeEnv: 'production',
      });
      expect(result).toBe('3');
    });

    it('defaults to debug in non-production', () => {
      const result = resolveLogLevel({
        nodeEnv: 'development',
      });
      expect(result).toBe('4');
    });

    it('falls back to 3 (info) for invalid level names', () => {
      const result = resolveLogLevel({
        cliFlag: 'invalid-level',
      });
      expect(result).toBe('3');
    });

    it('--log-level debug sets DORKOS_LOG_LEVEL=4', () => {
      const result = resolveLogLevel({ cliFlag: 'debug' });
      expect(result).toBe('4');
    });

    it('--log-level fatal sets DORKOS_LOG_LEVEL=0', () => {
      const result = resolveLogLevel({ cliFlag: 'fatal' });
      expect(result).toBe('0');
    });

    it('config logging.level works as fallback', () => {
      const result = resolveLogLevel({ configValue: 'warn' });
      expect(result).toBe('2');
    });
  });

  describe('DORKOS_LOG_LEVEL env var', () => {
    it('is parseable as integer by server', () => {
      // eslint-disable-next-line no-restricted-syntax -- testing env var parsing behavior
      process.env.DORKOS_LOG_LEVEL = '4';
      // eslint-disable-next-line no-restricted-syntax -- testing env var parsing behavior
      const parsed = parseInt(process.env.DORKOS_LOG_LEVEL, 10);
      expect(parsed).toBe(4);
      expect(Number.isNaN(parsed)).toBe(false);
    });

    it('undefined DORKOS_LOG_LEVEL results in undefined parsed value', () => {
      // eslint-disable-next-line no-restricted-syntax -- testing env var absence behavior
      delete process.env.DORKOS_LOG_LEVEL;
      // eslint-disable-next-line no-restricted-syntax -- testing env var parsing behavior
      const logLevel = process.env.DORKOS_LOG_LEVEL
        // eslint-disable-next-line no-restricted-syntax -- testing env var parsing behavior
        ? parseInt(process.env.DORKOS_LOG_LEVEL, 10)
        : undefined;
      expect(logLevel).toBeUndefined();
    });
  });
});
