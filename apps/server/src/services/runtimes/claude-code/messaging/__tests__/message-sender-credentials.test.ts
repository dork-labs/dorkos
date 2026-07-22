/**
 * Claude credential env-injection seam tests (ADR-0315,
 * effortless-runtime-switching T1 2.2).
 *
 * The Claude adapter injects a resolved `ANTHROPIC_API_KEY` into the SDK
 * subprocess env ONLY when a Claude credential reference is configured;
 * otherwise host/delegated-login auth is left untouched. The resolved secret
 * must never appear in any log line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCredentialEnv } from '../../../../core/credential-env.js';
import { logger } from '../../../../../lib/logger.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn(),
}));

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', sdkSessionIndex: new Map(), sessionMapKey: 's1', ...overrides };
}

async function captureSdkOptions(): Promise<Options> {
  let capturedOptions: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', makeSession(), makeOpts())) {
    // drain
  }
  return capturedOptions!;
}

describe('executeSdkQuery — Claude credential injection (ADR-0315)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects the resolved ANTHROPIC_API_KEY into sdkOptions.env when a reference is configured', async () => {
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({
      ANTHROPIC_API_KEY: 'sk-injected-xyz',
    });

    const options = await captureSdkOptions();

    const env = options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-injected-xyz');
    // Baseline control var still present (the injection is additive).
    expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });

  it('does not override env when no reference is configured (host auth untouched)', async () => {
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({});

    const options = await captureSdkOptions();

    const env = options.env as Record<string, string | undefined>;
    // No injected key: ANTHROPIC_API_KEY equals whatever the host env had.
    expect(env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
  });

  it('never logs the resolved secret', async () => {
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({
      ANTHROPIC_API_KEY: 'sk-secret-should-not-log',
    });

    await captureSdkOptions();

    const allLogArgs = [logger.info, logger.debug, logger.warn, logger.error]
      .flatMap((fn) => vi.mocked(fn).mock.calls)
      .map((call) => JSON.stringify(call));
    expect(allLogArgs.some((s) => s.includes('sk-secret-should-not-log'))).toBe(false);
  });
});
