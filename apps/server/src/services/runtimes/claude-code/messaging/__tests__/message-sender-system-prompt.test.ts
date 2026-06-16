/**
 * DOR-132 — runtime-neutral context channel, Phase 1.
 *
 * The Claude adapter must set `excludeDynamicSections: true` on the
 * `claude_code` preset so the SDK stops injecting its native
 * working-directory / auto-memory / git-status sections. DorkOS's own
 * server-derived `<git_status>` block (via `buildPerMessageContext`) then
 * becomes the single source of truth, ending the per-turn git double-injection
 * (ADR-0273 decision A2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  buildPerMessageContext: vi.fn().mockResolvedValue('<git_status>mock</git_status>'),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi.fn().mockReturnValue({
    tasks: true,
    relay: true,
    mesh: true,
    adapter: true,
  }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
  configManager: {
    get: vi.fn().mockReturnValue(undefined),
  },
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
  return {
    cwd: '/mock/project',
    sdkSessionIndex: new Map(),
    sessionMapKey: 's1',
    ...overrides,
  };
}

/**
 * Drive executeSdkQuery against an empty SDK stream and return the `Options`
 * that were passed to the SDK `query()` call.
 */
async function captureSdkOptions(): Promise<Options> {
  let capturedOptions: Options | undefined;

  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return {
      [Symbol.asyncIterator]: async function* () {}, // empty SDK stream
    } as unknown as ReturnType<typeof query>;
  });

  for await (const _event of executeSdkQuery('s1', 'hello', makeSession(), makeOpts())) {
    // drain
  }

  return capturedOptions!;
}

describe('executeSdkQuery — system prompt (DOR-132)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets excludeDynamicSections: true on the claude_code preset', async () => {
    const options = await captureSdkOptions();

    expect(options.systemPrompt).toEqual(
      expect.objectContaining({
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
      })
    );
  });

  it('still forwards the DorkOS system-prompt append alongside the strip flag', async () => {
    const options = await captureSdkOptions();

    expect(options.systemPrompt).toMatchObject({
      append: '<env>mock</env>',
      excludeDynamicSections: true,
    });
  });
});
