import { describe, it, expect, vi } from 'vitest';
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
import { handleConfigAcknowledgeAutonomy } from '../config-write.js';
import type { ConfigStore } from '../config-commands.js';
import type { CliConfigWriter, ConsentPrompt } from '../config-write.js';
import type { GuardedConfigWriteResult } from '../../server/services/core/operator/config-write.js';
import type { UserConfig } from '@dorkos/shared/config-schema';

const MOCK_CONFIG: UserConfig = {
  version: 1,
  server: { port: 4242, cwd: null, boundary: null, open: true },
  tunnel: {
    enabled: false,
    domain: null,
    authtoken: null,
    auth: null,
  },
  ui: { theme: 'system', dismissedUpgradeVersions: [] },
} as unknown as UserConfig;

function createMockStore(overrides?: Partial<UserConfig>): ConfigStore {
  const config = overrides ? { ...MOCK_CONFIG, ...overrides } : { ...MOCK_CONFIG };
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
        return {
          warning: `'${key}' contains sensitive data. Consider using environment variables instead.`,
        };
      }
      return {};
    }),
    reset: vi.fn(),
    validate: vi.fn(() => ({ valid: true })),
    path: '/tmp/.dork/config.json',
  };
}

/**
 * A stand-in for the server's guarded config write, which the CLI can only reach
 * through a specifier esbuild rewrites at bundle time — from source there is no
 * module to import. Defaults to a write that succeeded and changed nothing.
 */
function createMockWriter(outcome?: {
  warnings?: string[];
  refusal?: {
    status: number;
    code: string;
    error: string;
    message: string;
    paths: string[];
  };
  invalid?: { error: string; details?: string[] };
}): CliConfigWriter & { guarded: ReturnType<typeof vi.fn> } {
  const result = outcome?.refusal
    ? { ok: false as const, kind: 'refused' as const, refusal: outcome.refusal }
    : outcome?.invalid
      ? {
          ok: false as const,
          kind: 'invalid' as const,
          error: outcome.invalid.error,
          ...(outcome.invalid.details && { details: outcome.invalid.details }),
        }
      : {
          ok: true as const,
          config: MOCK_CONFIG,
          warnings: outcome?.warnings ?? [],
        };
  return {
    guarded: vi.fn(
      async (_patch: Record<string, unknown>, _source: string) => result as GuardedConfigWriteResult
    ),
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    expect(() => handleConfigGet(store, 'nonexistent')).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('handleConfigSet', () => {
  it('sends the write through the guarded step, as a patch, not straight to the store', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    const writer = createMockWriter();
    await handleConfigSet(store, 'server.port', '8080', writer);
    // The point of DOR-1247: `setDot` is no longer the write path, because it
    // was the one that ran no policy, no consent door and left no log line.
    expect(store.setDot).not.toHaveBeenCalled();
    expect(writer.guarded).toHaveBeenCalledWith({ server: { port: 8080 } }, 'dorkos config set');
    expect(logSpy).toHaveBeenCalledWith('Set server.port = 4242');
    logSpy.mockRestore();
  });

  it('confirms with the value that LANDED, not the one that was typed', async () => {
    // The mock store holds 4242 and does not accept writes, which is exactly the
    // discrimination wanted: printing the requested 8080 here would be the
    // command claiming a write it cannot see. What it prints is the read-back.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    await handleConfigSet(store, 'server.port', '8080', createMockWriter());
    expect(logSpy).toHaveBeenCalledWith('Set server.port = 4242');
    expect(logSpy).not.toHaveBeenCalledWith('Set server.port = 8080');
    logSpy.mockRestore();
  });

  it('refuses to address one item of a list, and says where to do it instead', async () => {
    // A patch REPLACES a list rather than reaching into it, so there is no patch
    // that means "element 0". Sent anyway it came back as "expected array,
    // received object", which reads like a bad value rather than a thing this
    // command cannot do.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    const writer = createMockWriter();

    await expect(
      handleConfigSet(store, 'ui.dismissedUpgradeVersions.0', '1.2.3', writer)
    ).rejects.toThrow('exit');

    expect(errorSpy.mock.calls[0][0]).toBe(
      'Cannot set one item of a list: ui.dismissedUpgradeVersions.0'
    );
    expect(errorSpy.mock.calls[1][0]).toContain('dorkos config edit');
    // Refused before anything was attempted, so no write was even proposed.
    expect(writer.guarded).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('keeps a literal dot in a key instead of splitting it into two settings', async () => {
    // The record-shaped sections take caller-chosen keys, and `dot-prop` (which
    // the store used to be handed the whole path) reads `\\.` as one. Building a
    // patch object with a naive split would quietly write `{ 'a': { 'b': … } }`.
    const store = createMockStore();
    // The mock store splits on every dot, so stand in for the real one's answer
    // to the post-write existence check; the patch shape is what is under test.
    (store.getDot as ReturnType<typeof vi.fn>).mockReturnValue('ref');
    const writer = createMockWriter();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleConfigSet(store, 'providers.my\\.provider', 'ref', writer);
    expect(writer.guarded).toHaveBeenCalledWith(
      { providers: { 'my.provider': 'ref' } },
      'dorkos config set'
    );
    vi.restoreAllMocks();
  });

  it('warns on sensitive key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createMockStore();
    const writer = createMockWriter({
      warnings: [
        "'tunnel.authtoken' contains sensitive data. Consider using environment variables instead.",
      ],
    });
    await handleConfigSet(store, 'tunnel.authtoken', 'my-token', writer);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('sensitive data');
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('prints the refusal and writes nothing when the guarded step says no', async () => {
    // The shape the Full-autonomy consent door produces. The CLI has to show
    // the server's own sentence — a refusal worded differently in the terminal
    // teaches people they are two different rules.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    const writer = createMockWriter({
      refusal: {
        status: 428,
        code: 'AUTONOMY_ACK_REQUIRED',
        error:
          'Starting every new session in Full autonomy needs you to confirm what it means first.',
        message:
          'Starting every new session in Full autonomy needs you to confirm what it means first.',
        paths: ['runtimes.claudeCode.defaultTrustStop'],
      },
    });

    await expect(
      handleConfigSet(store, 'runtimes.claudeCode.defaultTrustStop', 'autonomy', writer)
    ).rejects.toThrow('exit');

    expect(errorSpy.mock.calls[0][0]).toContain('confirm what it means first');
    // A sentence with no next step is a dead end at a terminal: the cockpit can
    // open its own dialog, a shell cannot.
    expect(errorSpy.mock.calls[1][0]).toContain('dorkos config acknowledge-autonomy');
    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it('says a setting does not exist rather than claiming it was set', async () => {
    // Zod drops what the schema does not declare, so the guarded write lands
    // nothing and `getDot` still reports undefined. The old path wrote the key
    // into the file and printed `Set …`, which is a lie a person then acts on.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    const writer = createMockWriter();

    await expect(handleConfigSet(store, 'bogus.key', '1', writer)).rejects.toThrow('exit');

    expect(errorSpy.mock.calls[0][0]).toBe('Unknown config key: bogus.key');
    expect(logSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('reports a value the schema refuses instead of storing it', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    const writer = createMockWriter({
      invalid: { error: 'Validation failed', details: ['server.port: expected number'] },
    });

    await expect(handleConfigSet(store, 'server.port', 'notanumber', writer)).rejects.toThrow(
      'exit'
    );

    expect(errorSpy.mock.calls[0][0]).toBe('Cannot set server.port: Validation failed');
    expect(errorSpy.mock.calls[1][0]).toContain('server.port: expected number');
    expect(logSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('handleConfigAcknowledgeAutonomy', () => {
  /** A store whose acknowledgement record can be posed. */
  function storeWithAck(ack: string | null): ConfigStore {
    const store = createMockStore();
    (store.getDot as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
      key === 'ui.autonomyAcknowledgedAt' ? ack : 'something'
    );
    return store;
  }

  it('prints what is being agreed to before it asks', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const asked: string[] = [];
    const writer = createMockWriter();

    await handleConfigAcknowledgeAutonomy(storeWithAck(null), writer, {
      available: () => true,
      ask: async (message: string) => {
        asked.push(message);
        // The text has to be on screen BEFORE the question, or it is a dialog
        // whose body renders after the button.
        expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'your agents stop asking first'
        );
        return false;
      },
    });

    expect(asked).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('records nothing when the answer is no', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writer = createMockWriter();

    await handleConfigAcknowledgeAutonomy(storeWithAck(null), writer, {
      available: () => true,
      ask: async () => false,
    });

    expect(writer.guarded).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('Nothing changed.');
    logSpy.mockRestore();
  });

  it('writes the record through the guarded step when the answer is yes', async () => {
    // Through the guarded step, not straight to the store: agreeing to this is
    // itself a change worth finding in the log later.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writer = createMockWriter();

    await handleConfigAcknowledgeAutonomy(storeWithAck(null), writer, {
      available: () => true,
      ask: async () => true,
    });

    expect(writer.guarded).toHaveBeenCalledTimes(1);
    const [patch, source] = writer.guarded.mock.calls[0] as [Record<string, unknown>, string];
    const ui = patch.ui as { autonomyAcknowledgedAt: string };
    expect(Number.isNaN(Date.parse(ui.autonomyAcknowledgedAt))).toBe(false);
    expect(source).toBe('dorkos config acknowledge-autonomy');
    logSpy.mockRestore();
  });

  it('refuses rather than signing itself when nothing is attached to answer', async () => {
    // A ritual needs somebody to perform it. A `--yes` here would be a consent
    // form that signs itself, which is the thing the door exists to prevent.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const writer = createMockWriter();

    await expect(
      handleConfigAcknowledgeAutonomy(storeWithAck(null), writer, {
        available: () => false,
        ask: async () => true,
      })
    ).rejects.toThrow('exit');

    expect(errorSpy.mock.calls[0][0]).toContain('nothing is attached to answer it');
    expect(writer.guarded).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not ask again once the record exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writer = createMockWriter();
    let asked = false;

    await handleConfigAcknowledgeAutonomy(storeWithAck('2026-08-16T09:00:00.000Z'), writer, {
      available: () => true,
      ask: async () => {
        asked = true;
        return true;
      },
    });

    expect(asked).toBe(false);
    expect(writer.guarded).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '2026-08-16T09:00:00.000Z'
    );
    logSpy.mockRestore();
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    expect(() => handleConfigValidate(store)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits 1 for invalid config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
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

  it('names a setting a newer version wrote, and still exits 0 (DOR-1227)', () => {
    // The file is fine and DorkOS started; telling somebody "validation failed"
    // here is what sends them off to delete it. But it must not be silent —
    // `auth.enabled` decides whether the login gate is on.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    vi.mocked(store.validate).mockReturnValue({
      valid: true,
      warnings: ['auth.enabled: "sso" (using false)'],
    });

    expect(() => handleConfigValidate(store)).toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    const printed = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Config is valid');
    expect(printed).toContain('auth.enabled: "sso" (using false)');
    expect(printed).toContain('newer version of DorkOS');
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('says nothing extra when every value is readable', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();

    expect(() => handleConfigValidate(store)).toThrow('exit');

    expect(spy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('newer version');
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('handleConfigCommand', () => {
  it('routes to default when no subcommand', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    await handleConfigCommand(store, [], createMockWriter());
    expect(store.getAll).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('routes get subcommand', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    await handleConfigCommand(store, ['get', 'server.port'], createMockWriter());
    expect(store.getDot).toHaveBeenCalledWith('server.port');
    spy.mockRestore();
  });

  it('routes set through the guarded writer it was handed', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createMockStore();
    const writer = createMockWriter();
    await handleConfigCommand(store, ['set', 'ui.theme', 'dark'], writer);
    expect(writer.guarded).toHaveBeenCalledWith({ ui: { theme: 'dark' } }, 'dorkos config set');
    spy.mockRestore();
  });

  it('exits 1 for unknown subcommand', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const store = createMockStore();
    await expect(handleConfigCommand(store, ['unknown'], createMockWriter())).rejects.toThrow(
      'exit'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});
