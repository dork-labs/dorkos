/**
 * Phantom-cancellation mitigation (DOR-1087) at the send-loop seam.
 *
 * The CLI cancels a pending tool call when a task-notification is queued
 * mid-turn, writing its interrupt sentinel as the tool_result — a message the
 * model reads as a user refusal. The loop must (1) steer a corrective note
 * into the held prompt stream so the model learns it was not the user, and
 * (2) yield a `system_status` event so the operator sees what happened. A
 * subagent's phantom (parent_tool_use_id set) is surfaced but never steered,
 * and a REAL operator deny must trigger neither.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { CLI_INTERRUPT_SENTINEL } from '../phantom-cancellation.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';

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
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../sdk/context-usage.js', () => ({
  fetchContextBreakdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../sdk/subscription-usage.js', () => ({
  fetchSubscriptionUsage: vi.fn().mockResolvedValue(undefined),
}));
// Inert mapper: the phantom path reads the RAW SDK message and yields its own
// system_status, independent of mapped output.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  // eslint-disable-next-line require-yield -- intentional empty async generator
  mapSdkMessage: vi.fn(async function* () {}),
}));

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {}, ...overrides };
}

function sentinelMsg(toolUseId: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    session_id: 'sdk-1',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content: CLI_INTERRUPT_SENTINEL,
        },
      ],
    },
  } as unknown as SDKMessage;
}

function resultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'sdk-1',
    is_error: false,
  } as unknown as SDKMessage;
}

/**
 * Drive one turn and capture (a) every StreamEvent yielded and (b) every user
 * message that traveled the held prompt stream (the steering channel).
 */
async function runTurn(
  session: AgentSession,
  messages: SDKMessage[]
): Promise<{ events: StreamEvent[]; promptMessages: string[] }> {
  const promptMessages: string[] = [];
  let drained: Promise<void> | undefined;
  vi.mocked(query).mockImplementation((args) => {
    // Consume the held prompt like the real subprocess would, recording each
    // user message (the initial prompt + any steered corrections).
    const prompt = args.prompt as AsyncIterable<{ message: { content: string } }>;
    drained = (async () => {
      for await (const m of prompt) promptMessages.push(m.message.content);
    })();
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const m of messages) yield m;
      },
    } as unknown as ReturnType<typeof query>;
  });
  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
    events.push(event);
  }
  await drained;
  return { events, promptMessages };
}

/** Narrow helper: StreamEvent's `data` is not discriminated by `type`. */
function isPhantomStatus(e: StreamEvent): boolean {
  return (
    e.type === 'system_status' && (e.data as { status?: string }).status === 'phantom_cancellation'
  );
}

describe('executeSdkQuery — phantom cancellation mitigation (DOR-1087)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('steers a corrective note and yields a system_status on a main-thread phantom', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      sentinelMsg('toolu_phantom'),
      resultMsg(),
    ]);

    const status = events.find(isPhantomStatus);
    expect(status).toBeDefined();

    expect(promptMessages[0]).toBe('hello');
    const note = promptMessages.find((m) => m.includes('toolu_phantom'));
    expect(note).toBeDefined();
    expect(note).toContain('not by the user');
  });

  it('surfaces but does NOT steer a subagent phantom', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      sentinelMsg('toolu_sub', 'toolu_parent'),
      resultMsg(),
    ]);

    expect(events.some(isPhantomStatus)).toBe(true);
    expect(promptMessages).toEqual(['hello']);
  });

  it('does nothing for a tool call the operator really denied', async () => {
    const session = makeSession({ operatorDeniedToolIds: new Set(['toolu_denied']) });
    const { events, promptMessages } = await runTurn(session, [
      sentinelMsg('toolu_denied'),
      resultMsg(),
    ]);

    expect(events.some(isPhantomStatus)).toBe(false);
    expect(promptMessages).toEqual(['hello']);
  });

  it('does nothing right after an operator interrupt', async () => {
    const session = makeSession({ interruptRequestedAt: Date.now() });
    const { events, promptMessages } = await runTurn(session, [
      sentinelMsg('toolu_after_stop'),
      resultMsg(),
    ]);

    expect(events.some(isPhantomStatus)).toBe(false);
    expect(promptMessages).toEqual(['hello']);
  });

  it('caps steered corrections per turn but keeps surfacing status events', async () => {
    const phantoms = ['a', 'b', 'c', 'd', 'e'].map((s) => sentinelMsg(`toolu_${s}`));
    const { events, promptMessages } = await runTurn(makeSession(), [...phantoms, resultMsg()]);

    const statuses = events.filter(isPhantomStatus);
    expect(statuses).toHaveLength(5);
    // 1 initial prompt + at most 3 steered notes (PHANTOM_CORRECTIONS_MAX_PER_TURN).
    expect(promptMessages).toHaveLength(4);
  });
});
