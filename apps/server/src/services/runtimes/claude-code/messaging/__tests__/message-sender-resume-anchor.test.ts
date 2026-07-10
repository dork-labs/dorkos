/**
 * Phantom "Continue from where you left off." regression.
 *
 * When the claude CLI resumes a session whose transcript ends with a bookkeeping
 * attachment (e.g. a Stop-hook `hook_success` entry), its resume classifier
 * treats the turn as interrupted and injects a synthetic
 * "Continue from where you left off." prompt — answered "No response requested."
 * — BEFORE the real message runs, so the operator sees a junk turn between every
 * interaction.
 *
 * The adapter defuses this by anchoring each resume at the last MAIN-THREAD
 * assistant message it produced (`options.resumeSessionAt`), which truncates the
 * loaded transcript past those trailing attachments so the classifier settles the
 * turn cleanly. These tests pin that contract at the SDK-options seam: no anchor
 * on the first turn, the prior turn's assistant uuid on the next, and subagent
 * messages never becoming the anchor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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
// Keep the mapper inert: the anchor is captured from the raw SDK message in the
// loop, independent of mapped output, so yielding nothing keeps the test focused.
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
  return { cwd: '/mock/project', sdkSessionIndex: new Map(), sessionMapKey: 's1', ...overrides };
}

/** A minimal main-thread assistant SDK message carrying `uuid`. */
function assistantMsg(uuid: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    session_id: 'sdk-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  } as unknown as SDKMessage;
}

/** The turn-completion `result` SDK message. */
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
 * Drive one `executeSdkQuery` turn: feed `messages` as the SDK stream and return
 * the `Options` passed to `query()`. Mutates `session` exactly as the real loop
 * would (commits the resume anchor in its `finally`).
 */
async function runTurn(
  session: AgentSession,
  messages: SDKMessage[],
  opts: MessageSenderOpts = makeOpts()
): Promise<Options> {
  let capturedOptions: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const m of messages) yield m;
      },
    } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', session, opts)) {
    // drain
  }
  return capturedOptions!;
}

describe('executeSdkQuery — resume anchor (phantom-continue fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT set resumeSessionAt on the first (non-resumed) turn', async () => {
    const session = makeSession({ hasStarted: false });
    const options = await runTurn(session, [assistantMsg('assistant-1'), resultMsg()]);

    expect(options.resume).toBeUndefined();
    expect(options.resumeSessionAt).toBeUndefined();
  });

  it('captures the last main-thread assistant uuid as the next-turn anchor', async () => {
    const session = makeSession({ hasStarted: false });
    await runTurn(session, [assistantMsg('assistant-1'), resultMsg()]);

    expect(session.lastAssistantUuid).toBe('assistant-1');
  });

  it("anchors the next resume at the prior turn's last assistant uuid", async () => {
    // Turn 1 (fresh) settles and records its assistant uuid.
    const session = makeSession({ hasStarted: false });
    await runTurn(session, [assistantMsg('assistant-1'), resultMsg()]);
    // Simulate the session now being "started" (the SDK init normally flips this).
    session.hasStarted = true;

    // Turn 2 must resume anchored at turn 1's assistant — the fix that keeps the
    // CLI from injecting a synthetic "Continue from where you left off." turn.
    const options = await runTurn(session, [assistantMsg('assistant-2'), resultMsg()]);

    expect(options.resume).toBe('sdk-1');
    expect(options.resumeSessionAt).toBe('assistant-1');
    // …and the anchor rolls forward to this turn's assistant for the turn after.
    expect(session.lastAssistantUuid).toBe('assistant-2');
  });

  it('never anchors on a SUBAGENT assistant message (parent_tool_use_id set)', async () => {
    const session = makeSession({ hasStarted: false });
    await runTurn(session, [
      assistantMsg('subagent-msg', 'tool-use-123'), // subagent — must be ignored
      assistantMsg('main-msg'), // main thread — the real anchor
      resultMsg(),
    ]);

    expect(session.lastAssistantUuid).toBe('main-msg');
  });

  it('clears the anchor after a turn that produced no assistant message', async () => {
    // Prior turn left an anchor.
    const session = makeSession({ hasStarted: true, lastAssistantUuid: 'stale-anchor' });

    // This turn yields only a result (empty/error turn) — the anchor must clear so
    // the next resume stays plain and keeps this turn's user message in context.
    await runTurn(session, [resultMsg()]);

    expect(session.lastAssistantUuid).toBeUndefined();
  });
});
