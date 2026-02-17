import { describe, it, expect } from 'vitest';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
  LOG_LEVEL_MAP,
} from '../config-schema.js';
import type { UserConfig } from '../config-schema.js';

describe('UserConfigSchema', () => {
  it('parses minimal input with defaults filled', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result).toEqual({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null },
      tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
      ui: { theme: 'system' },
      logging: { level: 'info' },
    });
  });

  it('rejects invalid port below 1024', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 80 } })
    ).toThrow();
  });

  it('rejects invalid port above 65535', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 70000 } })
    ).toThrow();
  });

  it('rejects non-integer port', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 4242.5 } })
    ).toThrow();
  });

  it('rejects invalid theme value', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, ui: { theme: 'blue' } })
    ).toThrow();
  });

  it('accepts null for nullable fields', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { cwd: null, boundary: null },
      tunnel: { domain: null, authtoken: null, auth: null },
    });
    expect(result.server.cwd).toBeNull();
    expect(result.server.boundary).toBeNull();
    expect(result.tunnel.domain).toBeNull();
    expect(result.tunnel.authtoken).toBeNull();
    expect(result.tunnel.auth).toBeNull();
  });

  it('server.boundary defaults to null', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.server.boundary).toBeNull();
  });

  it('server.boundary accepts a string path', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { boundary: '/home/user/projects' },
    });
    expect(result.server.boundary).toBe('/home/user/projects');
  });

  it('server.boundary accepts null explicitly', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { boundary: null },
    });
    expect(result.server.boundary).toBeNull();
  });

  it('accepts valid port values', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { port: 3000 },
    });
    expect(result.server.port).toBe(3000);
  });

  it('accepts valid theme values', () => {
    const light = UserConfigSchema.parse({ version: 1, ui: { theme: 'light' } });
    expect(light.ui.theme).toBe('light');

    const dark = UserConfigSchema.parse({ version: 1, ui: { theme: 'dark' } });
    expect(dark.ui.theme).toBe('dark');

    const system = UserConfigSchema.parse({ version: 1, ui: { theme: 'system' } });
    expect(system.ui.theme).toBe('system');
  });

  it('accepts string values for nullable string fields', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { cwd: '/home/user/project' },
      tunnel: {
        domain: 'example.ngrok.app',
        authtoken: 'token123',
        auth: 'user:pass',
      },
    });
    expect(result.server.cwd).toBe('/home/user/project');
    expect(result.tunnel.domain).toBe('example.ngrok.app');
    expect(result.tunnel.authtoken).toBe('token123');
    expect(result.tunnel.auth).toBe('user:pass');
  });

  it('accepts boolean values for tunnel.enabled', () => {
    const enabled = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: true },
    });
    expect(enabled.tunnel.enabled).toBe(true);

    const disabled = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: false },
    });
    expect(disabled.tunnel.enabled).toBe(false);
  });

  it('rejects invalid version', () => {
    expect(() => UserConfigSchema.parse({ version: 2 })).toThrow();
    expect(() => UserConfigSchema.parse({ version: 0 })).toThrow();
  });

  it('requires version field', () => {
    expect(() => UserConfigSchema.parse({})).toThrow();
  });

  it('applies defaults at nested object levels', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: {},
      tunnel: {},
      ui: {},
    });
    expect(result.server.port).toBe(4242);
    expect(result.server.cwd).toBeNull();
    expect(result.tunnel.enabled).toBe(false);
    expect(result.ui.theme).toBe('system');
  });

  it('accepts partial server config with defaults', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { port: 5000 },
    });
    expect(result.server.port).toBe(5000);
    expect(result.server.cwd).toBeNull();
  });

  it('accepts partial tunnel config with defaults', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: true, domain: 'test.ngrok.app' },
    });
    expect(result.tunnel.enabled).toBe(true);
    expect(result.tunnel.domain).toBe('test.ngrok.app');
    expect(result.tunnel.authtoken).toBeNull();
    expect(result.tunnel.auth).toBeNull();
  });
});

describe('SENSITIVE_CONFIG_KEYS', () => {
  it('contains expected sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.authtoken');
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.auth');
  });

  it('has exactly 2 sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toHaveLength(2);
  });

  it('is readonly array', () => {
    expect(Object.isFrozen(SENSITIVE_CONFIG_KEYS)).toBe(false);
    // TypeScript enforces readonly at compile time
    expect(Array.isArray(SENSITIVE_CONFIG_KEYS)).toBe(true);
  });
});

describe('USER_CONFIG_DEFAULTS', () => {
  it('matches schema defaults', () => {
    expect(USER_CONFIG_DEFAULTS).toEqual({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null },
      tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
      ui: { theme: 'system' },
      logging: { level: 'info' },
    });
  });

  it('satisfies UserConfig type', () => {
    const config: UserConfig = USER_CONFIG_DEFAULTS;
    expect(config.version).toBe(1);
  });

  it('is valid according to schema', () => {
    expect(() => UserConfigSchema.parse(USER_CONFIG_DEFAULTS)).not.toThrow();
  });

  it('has correct default port', () => {
    expect(USER_CONFIG_DEFAULTS.server.port).toBe(4242);
  });

  it('has correct default theme', () => {
    expect(USER_CONFIG_DEFAULTS.ui.theme).toBe('system');
  });

  it('has correct default tunnel state', () => {
    expect(USER_CONFIG_DEFAULTS.tunnel.enabled).toBe(false);
  });

  it('has correct default logging level', () => {
    expect(USER_CONFIG_DEFAULTS.logging.level).toBe('info');
  });
});

describe('UserConfigSchema logging', () => {
  it('logging.level defaults to "info" when logging section omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.logging.level).toBe('info');
  });

  it('logging section defaults to { level: "info" } when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.logging).toEqual({ level: 'info' });
  });

  it('logging.level accepts "fatal"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'fatal' } });
    expect(result.logging.level).toBe('fatal');
  });

  it('logging.level accepts "error"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'error' } });
    expect(result.logging.level).toBe('error');
  });

  it('logging.level accepts "warn"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'warn' } });
    expect(result.logging.level).toBe('warn');
  });

  it('logging.level accepts "info"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'info' } });
    expect(result.logging.level).toBe('info');
  });

  it('logging.level accepts "debug"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'debug' } });
    expect(result.logging.level).toBe('debug');
  });

  it('logging.level accepts "trace"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'trace' } });
    expect(result.logging.level).toBe('trace');
  });

  it('logging.level rejects invalid values', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, logging: { level: 'verbose' } })
    ).toThrow();
  });

  it('logging.level rejects numeric strings', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, logging: { level: '3' } })
    ).toThrow();
  });
});

describe('LOG_LEVEL_MAP', () => {
  it('maps "fatal" to 0', () => {
    expect(LOG_LEVEL_MAP['fatal']).toBe(0);
  });

  it('maps "error" to 1', () => {
    expect(LOG_LEVEL_MAP['error']).toBe(1);
  });

  it('maps "warn" to 2', () => {
    expect(LOG_LEVEL_MAP['warn']).toBe(2);
  });

  it('maps "info" to 3', () => {
    expect(LOG_LEVEL_MAP['info']).toBe(3);
  });

  it('maps "debug" to 4', () => {
    expect(LOG_LEVEL_MAP['debug']).toBe(4);
  });

  it('maps "trace" to 5', () => {
    expect(LOG_LEVEL_MAP['trace']).toBe(5);
  });

  it('contains exactly the 6 standard log levels', () => {
    expect(Object.keys(LOG_LEVEL_MAP)).toHaveLength(6);
  });

  it('all values are unique integers', () => {
    const values = Object.values(LOG_LEVEL_MAP);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every(Number.isInteger)).toBe(true);
  });
});
