/**
 * An agent computer registers OpenCode and nothing else (DOR-2940), whatever
 * the config turns on: Claude Code and Codex sign in with a person's own
 * account, which an agent computer never holds. Every runtime class is a
 * stub that records its type, so the case reads what actually registered.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../env.js', () => ({ env: {} }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    // Every optional runtime switched on, so only the role can leave one out.
    get: () => ({
      codex: { enabled: true, transport: 'sdk' },
      opencode: { enabled: true },
      doe: { enabled: true },
      default: 'claude-code',
    }),
    onChange: () => () => {},
  },
}));
const registered = vi.hoisted(() => ({ types: [] as string[], defaultType: '' }));
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    register: (runtime: { type: string }) => registered.types.push(runtime.type),
    setDefault: (type: string) => (registered.defaultType = type),
  },
  applyAndWatchConfiguredDefaultRuntime: vi.fn(),
  registerOptionalRuntime: (_name: string, _remedy: string, init: () => unknown) => init(),
}));
vi.mock('../../services/core/auth/cloud-link.js', () => ({ initCloudLinkManager: vi.fn() }));
const relay = vi.hoisted(() => ({ value: { issue: () => ({ baseUrl: '', key: '' }) } }));
vi.mock('../../services/core/cloud/credits-relay.js', () => ({
  startCreditsRelay: vi.fn(async () => relay.value),
}));
vi.mock('../computers.js', () => ({ registerComputerRuntime: vi.fn(async () => undefined) }));
vi.mock('../../services/session/attachments/index.js', () => ({
  LocalSessionAttachmentStore: class {},
  setSessionAttachmentStore: vi.fn(),
}));

/** A runtime stub of one type. */
function stubRuntime(type: string) {
  return class {
    readonly type = type;
    setSessionSettings(): void {}
    warmup = async () => undefined;
    refreshActivatedPlugins = async () => undefined;
    hydrateSessions = async () => undefined;
  };
}
vi.mock('../../services/runtimes/claude-code/claude-code-runtime.js', () => ({
  ClaudeCodeRuntime: stubRuntime('claude-code'),
}));
vi.mock('../../services/runtimes/codex/index.js', () => ({
  CodexRuntime: stubRuntime('codex'),
  CodexThreadMap: class {},
}));
vi.mock('../../services/runtimes/codex/transport/index.js', () => ({
  resolveCodexTransport: () => 'sdk',
}));
vi.mock('../../services/runtimes/doe/index.js', () => ({ DoeRuntime: stubRuntime('doe') }));
vi.mock('../../services/runtimes/opencode/index.js', () => ({
  OpenCodeRuntime: stubRuntime('opencode'),
  OpenCodeSessionMap: class {},
  openCodeServerManager: { usePlanners: vi.fn() },
  planOpenCodeSidecar: vi.fn(),
  planOpenCodeTurn: vi.fn(),
}));

const {
  AGENT_COMPUTER_RELAY_ATTEMPTS,
  CreditsRelayUnavailableError,
  registerRuntimes,
  startAgentComputerRelay,
} = await import('../runtimes.js');
const { openCodeServerManager } = await import('../../services/runtimes/opencode/index.js');

const DEPS = { db: {} as never, dorkHome: '/tmp/dork', currentCreditsRelay: () => null };

beforeEach(() => {
  registered.types = [];
  registered.defaultType = '';
});

describe('registering runtimes on an agent computer', () => {
  it('registers OpenCode alone, as the default, on its own credits relay', async () => {
    const result = await registerRuntimes(DEPS);
    expect(registered.types).toEqual(['opencode']);
    expect(registered.defaultType).toBe('opencode');
    expect(result).toEqual({
      claudeRuntime: null,
      doeRuntime: null,
      relayAgentRuntime: null,
      creditsRelay: relay.value,
    });
    expect(openCodeServerManager.usePlanners).toHaveBeenCalledWith(
      expect.objectContaining({ relay: relay.value })
    );
  });

  it('registers Claude Code and Codex on a person`s own computer', async () => {
    role.value = 'computer';
    await registerRuntimes(DEPS);
    expect(registered.types).toEqual(expect.arrayContaining(['claude-code', 'codex', 'opencode']));
    role.value = 'agent-computer';
  });
});

describe('starting an agent computer`s credits relay', () => {
  it('tries again with growing waits, and returns the relay once it starts', async () => {
    const waits: number[] = [];
    let tries = 0;
    const started = await startAgentComputerRelay(
      async () => {
        tries += 1;
        if (tries < 3) throw new Error('EADDRINUSE');
        return relay.value as never;
      },
      async (ms) => void waits.push(ms)
    );
    expect(started).toBe(relay.value);
    expect(waits).toEqual([500, 1000]);
  });

  it('gives up after the last try, failing the boot so Cloud restarts the computer', async () => {
    const waits: number[] = [];
    let tries = 0;
    await expect(
      startAgentComputerRelay(
        async () => {
          tries += 1;
          throw new Error('EADDRINUSE');
        },
        async (ms) => void waits.push(ms)
      )
    ).rejects.toBeInstanceOf(CreditsRelayUnavailableError);
    expect(tries).toBe(AGENT_COMPUTER_RELAY_ATTEMPTS);
    expect(waits).toEqual([500, 1000, 2000, 4000]);
  });
});
