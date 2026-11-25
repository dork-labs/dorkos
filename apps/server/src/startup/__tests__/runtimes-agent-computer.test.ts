/**
 * An agent computer registers OpenCode and nothing else (DOR-2940), whatever
 * the config turns on: Claude Code and Codex sign in with a person's own
 * account, which an agent computer never holds. The registry is the real
 * one; every runtime class is a stub of its type, so the case reads what a
 * person would see in the runtime list.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

// `currentServerRole()` reads this, so the real role module decides.
const env = vi.hoisted(() => ({ DORKOS_SERVER_ROLE: 'agent-computer' }));
vi.mock('../../env.js', () => ({ env }));
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
vi.mock('../../services/core/auth/cloud-link.js', () => ({ initCloudLinkManager: vi.fn() }));
vi.mock('../../services/core/cloud/credits-relay.js', () => ({
  startCreditsRelay: vi.fn(async () => null),
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

const { registerRuntimes } = await import('../runtimes.js');
const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');

const DEPS = { db: {} as never, dorkHome: '/tmp/dork', currentCreditsRelay: () => null };

const registeredTypes = (): string[] => runtimeRegistry.listRuntimes().map((r) => r.type);

describe('registering runtimes on an agent computer', () => {
  it('registers OpenCode alone, as the default', async () => {
    const result = await registerRuntimes(DEPS);
    expect(registeredTypes()).toEqual(['opencode']);
    expect(runtimeRegistry.getDefaultType()).toBe('opencode');
    expect(result).toEqual({
      claudeRuntime: null,
      doeRuntime: null,
      relayAgentRuntime: null,
      creditsRelay: null,
    });
  });

  // Runs second, on the same registry: the control that shows the role, not
  // the config, left the others out above.
  it('registers Claude Code and Codex on a person`s own computer', async () => {
    env.DORKOS_SERVER_ROLE = 'computer';
    await registerRuntimes(DEPS);
    expect(registeredTypes()).toEqual(expect.arrayContaining(['claude-code', 'codex', 'opencode']));
    env.DORKOS_SERVER_ROLE = 'agent-computer';
  });
});
