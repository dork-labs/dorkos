/**
 * `session.activeQuery` ownership across overlapping turns (DOR-1088).
 *
 * `activeQuery` is the session's control channel — interrupt, model change,
 * context-usage fetch all reach for it. Every turn installed its own query there
 * and then cleared it unconditionally when it settled, which is only correct
 * while one turn can ever be in flight. When two overlapped (the bug this ticket
 * closed at the trigger seam), the FIRST to finish handed the survivor a session
 * whose control channel was `undefined`: still streaming, no longer stoppable.
 *
 * The clear is now instance-identity matched, so a frame only ever puts back
 * what it installed. These tests pin that, and they drive the overlap directly
 * rather than through a trigger — the guard has to hold on its own, whatever
 * upstream does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { fetchContextBreakdown } from '../../sdk/context-usage.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
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
// Inert mapper: these tests read session state, never mapped output.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  mapSdkMessage: vi.fn(async function* () {}),
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

function makeOpts(): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
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

/** A promise plus the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('executeSdkQuery — activeQuery ownership (DOR-1088)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a late-settling frame leaves a newer turn’s activeQuery alone', async () => {
    const session = makeSession();
    // One gate per SDK stream, so each turn can be parked and finished by hand.
    const gates = [gate(), gate()];
    /** The query objects handed back to each frame, in creation order. */
    const queries: unknown[] = [];

    vi.mocked(query).mockImplementation(() => {
      const index = queries.length;
      const handle = {
        [Symbol.asyncIterator]: async function* () {
          await gates[index]!.wait;
          yield resultMsg();
        },
      };
      queries.push(handle);
      return handle as unknown as ReturnType<typeof query>;
    });

    /** Drain a turn to completion in the background. */
    const drain = async (content: string): Promise<void> => {
      for await (const _event of executeSdkQuery('s1', content, session, makeOpts())) {
        // events are irrelevant here
      }
    };

    const turnA = drain('first');
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    expect(session.activeQuery).toBe(queries[0]);

    // A second turn starts while the first is still open and takes the control
    // channel. This is the state the trigger queue now prevents; the guard below
    // must hold even when something gets past it.
    const turnB = drain('second');
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    expect(session.activeQuery).toBe(queries[1]);

    // The FIRST turn settles. It must put back only what it installed — and it
    // no longer holds the channel, so it must leave it exactly as it found it.
    gates[0]!.open();
    await turnA;
    expect(session.activeQuery).toBe(queries[1]);
    expect(session.lastQuery).toBeUndefined();

    // The usage breakdown for turn A's `result` must be read off turn A's own
    // subprocess. Read off the shared slot it came from whichever turn happened
    // to be installed — the wrong process entirely, reporting the wrong numbers.
    expect(vi.mocked(fetchContextBreakdown)).toHaveBeenCalledWith(queries[0], expect.anything());

    // The surviving turn settles normally: it DOES own the channel, so it clears
    // it and records itself as the last query for post-stream control calls.
    gates[1]!.open();
    await turnB;
    expect(session.activeQuery).toBeUndefined();
    expect(session.lastQuery).toBe(queries[1]);
  });

  it('a lone turn still clears the channel it owns', async () => {
    const session = makeSession();
    const queries: unknown[] = [];
    vi.mocked(query).mockImplementation(() => {
      const handle = {
        [Symbol.asyncIterator]: async function* () {
          yield resultMsg();
        },
      };
      queries.push(handle);
      return handle as unknown as ReturnType<typeof query>;
    });

    for await (const _event of executeSdkQuery('s1', 'solo', session, makeOpts())) {
      // drain
    }

    expect(session.activeQuery).toBeUndefined();
    expect(session.lastQuery).toBe(queries[0]);
  });
});
