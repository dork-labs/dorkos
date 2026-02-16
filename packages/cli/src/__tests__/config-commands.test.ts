import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseConfigValue,
  handleConfigDefault,
  handleConfigGet,
  handleConfigSet,
  handleConfigList,
  handleConfigReset,
  handleConfigPath,
  handleConfigValidate,
  handleConfigCommand,
} from '../config-commands.js';
import type { ConfigStore } from '../config-commands.js';
import type { UserConfig } from '@dorkos/shared/config-schema';

const MOCK_CONFIG: UserConfig = {
  version: 1,
  server: { port: 4242, cwd: null },
  tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
  ui: { theme: 'system' },
};

function createMockStore(overrides?: Partial<UserConfig>): ConfigStore {
  const config = overrides
    ? { ...MOCK_CONFIG, ...overrides }
    : { ...MOCK_CONFIG };
  return {
    getAll: vi.fn(() => config),
    getDot: vi.fn((key: string) => {
      const parts = key.split('.');
      let current: unknown = config;
      for (const part of parts) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    }),
    setDot: vi.fn((key: string) => {
      if (key === 'tunnel.authtoken' || key === 'tunnel.auth') {
        return { warning: `'${key}' contains sensitive data. Consider using environment variables instead.` };
      }
      return {};
    }),
    reset: vi.fn(),
    validate: vi.fn(() => ({ valid: true })),
    path: '/tmp/.dork/config.json',
  };
}

describe('parseConfigValue', () => {
  it('converts "true" to boolean true', () => {
    expect(parseConfigValue('true')).toBe(true);
  });

  it('converts "false" to boolean false', () => {
    expect(parseConfigValue('false')).toBe(false);
  });

  it('converts "null" to null', () => {
    expect(parseConfigValue('null')).toBeNull();
  });

  it('converts numeric strings to numbers', () => {
    expect(parseConfigValue('4242')).toBe(4242);
    expect(parseConfigValue('0')).toBe(0);
    expect(parseConfigValue('3.14')).toBe(3.14);
  });

  it('passes plain strings through unchanged', () => {
    expect(parseConfigValue('dark')).toBe('dark');
    expect(parseConfigValue('/Users/me')).toBe('/Users/me');
  });

  it('preserves empty string as string', () => {
    expect(parseConfigValue('')).toBe('');
  });
});

describe('handleConfigDefault', () => {
  it('prints config with source indicators', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigDefault(store);
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('server.port');
    expect(output).toContain('(default)');
    expect(output).toContain('Config file:');
    spy.mockRestore();
  });
});

describe('handleConfigGet', () => {
  it('prints the value for a valid key', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigGet(store, 'server.port');
    expect(spy).toHaveBeenCalledWith('4242');
    spy.mockRestore();
  });

  it('prints "null" for null values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigGet(store, 'server.cwd');
    expect(spy).toHaveBeenCalledWith('null');
    spy.mockRestore();
  });

  it('exits with code 1 for unknown key', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const store = createMockStore();
    expect(() => handleConfigGet(store, 'nonexistent')).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('handleConfigSet', () => {
  it('sets a value and confirms', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigSet(store, 'server.port', '8080');
    expect(store.setDot).toHaveBeenCalledWith('server.port', 8080);
    expect(logSpy).toHaveBeenCalledWith('Set server.port = 8080');
    logSpy.mockRestore();
  });

  it('warns on sensitive key', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigSet(store, 'tunnel.authtoken', 'my-token');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('sensitive data');
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('handleConfigList', () => {
  it('outputs JSON', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigList(store);
    const output = spy.mock.calls[0][0];
    expect(JSON.parse(output)).toEqual(MOCK_CONFIG);
    spy.mockRestore();
  });
});

describe('handleConfigReset', () => {
  it('resets specific key', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigReset(store, 'server.port');
    expect(store.reset).toHaveBeenCalledWith('server.port');
    spy.mockRestore();
  });

  it('resets all settings', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigReset(store);
    expect(store.reset).toHaveBeenCalledWith();
    spy.mockRestore();
  });
});

describe('handleConfigPath', () => {
  it('prints the config file path', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigPath(store);
    expect(spy).toHaveBeenCalledWith('/tmp/.dork/config.json');
    spy.mockRestore();
  });
});

describe('handleConfigValidate', () => {
  it('exits 0 for valid config', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const store = createMockStore();
    expect(() => handleConfigValidate(store)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits 1 for invalid config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const store = createMockStore();
    vi.mocked(store.validate).mockReturnValue({
      valid: false,
      errors: ['server.port: Expected number, received string'],
    });
    expect(() => handleConfigValidate(store)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('handleConfigCommand', () => {
  it('routes to default when no subcommand', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigCommand(store, []);
    expect(store.getAll).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('routes get subcommand', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    handleConfigCommand(store, ['get', 'server.port']);
    expect(store.getDot).toHaveBeenCalledWith('server.port');
    spy.mockRestore();
  });

  it('exits 1 for unknown subcommand', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const store = createMockStore();
    expect(() => handleConfigCommand(store, ['unknown'])).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});
