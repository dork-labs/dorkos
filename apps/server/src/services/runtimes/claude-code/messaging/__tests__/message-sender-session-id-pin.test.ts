/**
 * One id per conversation (DOR-2712).
 *
 * A brand-new session is launched with `options.sessionId` set to the id
 * DorkOS handed out, so the SDK stores, lists and resumes the conversation under
 * that same id. Before this, the SDK minted its own id and DorkOS kept the link
 * between the two in memory only: `session_start` could return the id DorkOS
 * minted, and after a restart that id addressed nothing, so a message posted to
 * it started a stranger session instead.
 *
 * These tests pin the contract at the SDK-options seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
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
const idTaken = vi.hoisted(() => ({ value: false }));
vi.mock('../../sessions/session-root-index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sessions/session-root-index.js')>()),
  transcriptIdTaken: vi.fn(async () => idTaken.value),
}));
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  // eslint-disable-next-line require-yield -- intentional empty async generator
  mapSdkMessage: vi.fn(async function* () {}),
}));

const DORKOS_ID = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f12';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: DORKOS_ID,
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
}

function resultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: DORKOS_ID,
    is_error: false,
  } as unknown as SDKMessage;
}

/** Each `query()` call's options, in order; `fail` makes the nth call throw. */
async function runTurn(
  sessionId: string,
  session: AgentSession,
  fail: Record<number, Error> = {}
): Promise<Options[]> {
  const calls: Options[] = [];
  vi.mocked(query).mockImplementation((args) => {
    const n = calls.length;
    calls.push(args.options!);
    return {
      [Symbol.asyncIterator]: async function* () {
        if (fail[n]) throw fail[n];
        yield resultMsg();
      },
    } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery(sessionId, 'hello', session, makeOpts())) {
    // drain
  }
  return calls;
}

describe('executeSdkQuery — one id per conversation (DOR-2712)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idTaken.value = false;
  });

  it('RT-SES-04: launches a new session under the id DorkOS handed out', async () => {
    const [options] = await runTurn(DORKOS_ID, makeSession());

    expect(options.sessionId).toBe(DORKOS_ID);
    expect(options.resume).toBeUndefined();
  });

  it('resumes a started session and never pins an id alongside resume', async () => {
    const [options] = await runTurn(DORKOS_ID, makeSession({ hasStarted: true }));

    expect(options.resume).toBe(DORKOS_ID);
    expect(options.sessionId).toBeUndefined();
  });

  it('leaves an id the SDK would refuse to the SDK', async () => {
    const [options] = await runTurn('room-turn-1', makeSession({ sdkSessionId: 'room-turn-1' }));

    expect(options.sessionId).toBeUndefined();
  });

  it('leaves an id a transcript already has to the SDK', async () => {
    // The per-folder probe missed it (another folder or account), so the
    // session looks new; launching under it would give two transcripts one id.
    idTaken.value = true;
    const [options] = await runTurn(DORKOS_ID, makeSession());

    expect(options.sessionId).toBeUndefined();
  });

  it('lets the SDK mint a fresh id when a failed resume restarts the session as new', async () => {
    // The old id already has a transcript the resume could not load; reusing it
    // for the new conversation would write into that file.
    const calls = await runTurn(DORKOS_ID, makeSession({ hasStarted: true }), {
      0: new Error('Session not found'),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.resume).toBe(DORKOS_ID);
    expect(calls[1]!.resume).toBeUndefined();
    expect(calls[1]!.sessionId).toBeUndefined();
  });
});
