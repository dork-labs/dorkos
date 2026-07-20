import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpencodeClient, GlobalEvent } from '@opencode-ai/sdk';
import type { DependencyCheck, SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { wrapKickoff, filterKickoffHistory } from '@dorkos/shared/kickoff';
import { SESSIONS } from '../../../../config/constants.js';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { OPENCODE_CAPABILITIES } from '../runtime-constants.js';
import { checkOpenCodeDependencies } from '../check-dependencies.js';
import { TurnEventQueue } from '../global-event-hub.js';
import {
  DIRECTORY,
  OTHER_DIRECTORY,
  OC_SESSION_A,
  OC_SESSION_B,
  globalEvent,
  serverConnected,
  sessionInfo,
  sessionIdle,
  sessionError,
  abortedError,
  statusEvent,
  partUpdated,
  partDelta,
  textPart,
  toolPart,
  toolStatePending,
  permission,
  permissionUpdated,
  permissionReplied,
  opencodeSimpleTurn,
} from './opencode-sse-fixtures.js';

vi.mock('../check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
}));

const SATISFIED_CHECKS: DependencyCheck[] = [
  {
    name: 'OpenCode CLI',
    description: 'The OpenCode CLI powers OpenCode agent sessions in DorkOS.',
    status: 'satisfied',
    version: '1.17.13',
  },
];

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';

let sessionCounter = 0;
/** Unique DorkOS session id per test — projector/module state is global. */
function nextSessionId(): string {
  sessionCounter += 1;
  return `${SESSION_ID.slice(0, -4)}${String(sessionCounter).padStart(4, '0')}`;
}

/**
 * One fake `/global/event` connection: a push-controlled GlobalEvent stream
 * that ends cleanly when the hub aborts it (fresh-client resubscribe safe).
 */
interface FakeConnection {
  queue: TurnEventQueue<GlobalEvent>;
  push(event: GlobalEvent): void;
  fail(error: unknown): void;
}

/**
 * Factory backing `client.global.event`: every call mints a FRESH connection
 * (exactly like a restarted sidecar would) and honors the abort signal.
 */
function makeGlobalSource() {
  const connections: FakeConnection[] = [];
  const impl = vi.fn(
    async (options?: { signal?: AbortSignal; onSseError?: (error: unknown) => void }) => {
      const queue = new TurnEventQueue<GlobalEvent>();
      options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
      connections.push({
        queue,
        push: (event) => queue.push(event),
        fail: (error) => queue.fail(error),
      });
      return { stream: queue };
    }
  );
  return {
    impl,
    connections,
    latest: (): FakeConnection => connections[connections.length - 1]!,
  };
}

function createMockClient() {
  const source = makeGlobalSource();
  const client = {
    global: { event: source.impl },
    session: {
      create: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_A, DIRECTORY) })),
      get: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_A, DIRECTORY) })),
      list: vi.fn(async () => ({ data: [] })),
      messages: vi.fn(async () => ({ data: [] })),
      update: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_A, DIRECTORY) })),
      fork: vi.fn(async () => ({ data: sessionInfo(OC_SESSION_B, DIRECTORY) })),
      promptAsync: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({ data: true })),
      todo: vi.fn(async () => ({ data: [] })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
  };
  return { client, source };
}

type MockClient = ReturnType<typeof createMockClient>['client'];

function createProvider(client: MockClient | null) {
  return {
    getClient: vi.fn(async () => {
      if (!client) throw new Error('sidecar unavailable');
      return client as unknown as OpencodeClient;
    }),
    peekClient: vi.fn(() => (client ? (client as unknown as OpencodeClient) : null)),
  };
}

function createSettingsPort(): SessionSettingsPort & {
  getSessionSettings: ReturnType<typeof vi.fn>;
  saveSessionSettings: ReturnType<typeof vi.fn>;
} {
  return {
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => undefined),
  };
}

/** Full harness: runtime + mocked provider/client + controllable global stream. */
function makeRuntime() {
  const { client, source } = createMockClient();
  const provider = createProvider(client);
  const settingsPort = createSettingsPort();
  const runtime = new OpenCodeRuntime({ provider });
  runtime.setSessionSettings(settingsPort);
  return { runtime, client, source, provider, settingsPort };
}

/** Start consuming a sendMessage stream, collecting events as they arrive. */
function consume(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  const finished = (async () => {
    for await (const event of gen) events.push(event);
    return events;
  })();
  return { events, finished };
}

/**
 * Drive a turn to the point where the sidecar accepted the prompt: waits for
 * the hub connection, marks it live, and waits for promptAsync.
 */
async function openTurn(harness: ReturnType<typeof makeRuntime>): Promise<FakeConnection> {
  await vi.waitFor(() => expect(harness.client.global.event).toHaveBeenCalled());
  const connection = harness.source.latest();
  connection.push(globalEvent(DIRECTORY, serverConnected()));
  await vi.waitFor(() => expect(harness.client.session.promptAsync).toHaveBeenCalled());
  return connection;
}

describe('OpenCodeRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkOpenCodeDependencies).mockReturnValue(SATISFIED_CHECKS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('identity and dependencies', () => {
    it('identifies as the opencode runtime', () => {
      const { runtime } = makeRuntime();
      expect(runtime.type).toBe('opencode');
    });

    it('delegates checkDependencies to checkOpenCodeDependencies', async () => {
      const { runtime } = makeRuntime();
      const checks = await runtime.checkDependencies();
      expect(checkOpenCodeDependencies).toHaveBeenCalledOnce();
      expect(checks).toEqual(SATISFIED_CHECKS);
    });

    it('getInternalSessionId is always undefined (C1 rekey trap)', () => {
      const { runtime } = makeRuntime();
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      expect(runtime.getInternalSessionId(sessionId)).toBeUndefined();
    });
  });

  describe('ensureSession', () => {
    it('tracks the session and eagerly binds it to a real OpenCode session', async () => {
      const { runtime, client } = makeRuntime();
      const sessionId = nextSessionId();

      expect(runtime.hasSession(sessionId)).toBe(false);
      runtime.ensureSession(sessionId, { permissionMode: 'acceptEdits', cwd: DIRECTORY });

      expect(runtime.hasSession(sessionId)).toBe(true);
      await vi.waitFor(() =>
        expect(client.session.create).toHaveBeenCalledWith({
          body: {},
          query: { directory: DIRECTORY },
        })
      );
    });

    it('survives an eager bind failure (retried on first message)', async () => {
      const { runtime, client } = makeRuntime();
      client.session.create.mockRejectedValueOnce(new Error('sidecar cold'));
      const sessionId = nextSessionId();

      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());
      expect(runtime.hasSession(sessionId)).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('triggers promptAsync and streams demuxed mapped events including raw-wire text deltas', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      const { finished } = consume(runtime.sendMessage(sessionId, 'hello', { cwd: DIRECTORY }));
      const connection = await openTurn(harness);

      const promptCall = client.session.promptAsync.mock.calls[0]![0]!;
      expect(promptCall.path).toEqual({ id: OC_SESSION_A });
      const promptParts = (promptCall.body as { parts: { text: string; synthetic?: boolean }[] })
        .parts;
      // The static <gen_ui> block leads as a synthetic part; user content follows.
      expect(promptParts).toHaveLength(2);
      expect(promptParts[0]!.synthetic).toBe(true);
      expect(promptParts[0]!.text).toContain('<gen_ui>');
      expect(promptParts[1]).toEqual({ type: 'text', text: 'hello' });

      // Interleave another session's events and a same-id/other-directory
      // intruder — only session A's events in ITS OpenCode-stored directory
      // may surface.
      connection.push(globalEvent(DIRECTORY, partUpdated(textPart(OC_SESSION_B, 'prt_b', 'X'))));
      connection.push(globalEvent(OTHER_DIRECTORY, partDelta(OC_SESSION_A, 'prt_x', 'INTRUDER')));
      for (const event of opencodeSimpleTurn(OC_SESSION_A, 'Hello there')) {
        connection.push(globalEvent(DIRECTORY, event));
      }

      const events = await finished;
      const textDeltas = events.filter((e) => e.type === 'text_delta');
      expect(textDeltas.map((e) => (e.data as { text: string }).text).join('')).toBe('Hello there');
      // The true increments ride message.part.delta — one delta per wire chunk.
      expect(textDeltas.length).toBe(2);
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events[events.length - 1]!.type).toBe('done');
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('demuxes on the OpenCode-stored directory, not the DorkOS cwd', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      // OpenCode normalizes the stored directory; the DorkOS cwd drifts with a
      // trailing slash. Events are tagged with the STORED directory.
      client.session.create.mockResolvedValue({ data: sessionInfo(OC_SESSION_A, DIRECTORY) });
      client.session.get.mockResolvedValue({ data: sessionInfo(OC_SESSION_A, DIRECTORY) });
      const sessionId = nextSessionId();

      const { finished } = consume(
        runtime.sendMessage(sessionId, 'hello', { cwd: `${DIRECTORY}/` })
      );
      const connection = await openTurn(harness);
      for (const event of opencodeSimpleTurn(OC_SESSION_A, 'Hi')) {
        connection.push(globalEvent(DIRECTORY, event));
      }

      const events = await finished;
      expect(events.some((e) => e.type === 'text_delta')).toBe(true);
      expect(events[events.length - 1]!.type).toBe('done');
    });

    it('hydrates persisted settings for untracked sessions and projects the model pair', async () => {
      const harness = makeRuntime();
      const { runtime, client, settingsPort } = harness;
      settingsPort.getSessionSettings.mockResolvedValue({
        permissionMode: 'default',
        model: 'ollama/llama3.3:70b',
      });
      const sessionId = nextSessionId();

      const { finished } = consume(runtime.sendMessage(sessionId, 'hi', { cwd: DIRECTORY }));
      const connection = await openTurn(harness);

      expect(settingsPort.getSessionSettings).toHaveBeenCalledWith(sessionId);
      const call = client.session.promptAsync.mock.calls[0]![0]!;
      expect(call.path).toEqual({ id: OC_SESSION_A });
      const projectedBody = call.body as {
        parts: { type: string; text: string; synthetic?: boolean }[];
        model: { providerID: string; modelID: string };
      };
      expect(projectedBody.model).toEqual({ providerID: 'ollama', modelID: 'llama3.3:70b' });
      // The static <gen_ui> teaching block leads as a synthetic part; content follows.
      expect(projectedBody.parts).toHaveLength(2);
      expect(projectedBody.parts[0]!.synthetic).toBe(true);
      expect(projectedBody.parts[0]!.text).toContain('<gen_ui>');
      expect(projectedBody.parts[1]).toEqual({ type: 'text', text: 'hi' });

      for (const event of opencodeSimpleTurn(OC_SESSION_A, 'ok')) {
        connection.push(globalEvent(DIRECTORY, event));
      }
      await finished;
    });

    it('renders context as a synthetic part, keeping user content pristine', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();

      const { finished } = consume(
        runtime.sendMessage(sessionId, 'do it', {
          cwd: DIRECTORY,
          systemPromptAppend: 'Scheduled task context',
        })
      );
      const connection = await openTurn(harness);

      const body = client.session.promptAsync.mock.calls[0]![0]!.body as {
        parts: { type: string; text: string; synthetic?: boolean }[];
      };
      expect(body.parts).toHaveLength(2);
      // The synthetic part leads with the static <gen_ui> teaching block, then
      // carries the scheduler's systemPromptAppend.
      expect(body.parts[0]!.type).toBe('text');
      expect(body.parts[0]!.synthetic).toBe(true);
      expect(body.parts[0]!.text).toContain('<gen_ui>');
      expect(body.parts[0]!.text).toContain('Scheduled task context');
      expect(body.parts[1]).toEqual({ type: 'text', text: 'do it' });

      for (const event of opencodeSimpleTurn(OC_SESSION_A, 'ok')) {
        connection.push(globalEvent(DIRECTORY, event));
      }
      await finished;
    });
  });

  describe('approvals', () => {
    /** Run a turn up to a pending bash permission and return the live pieces. */
    async function turnWithPermission(
      harness: ReturnType<typeof makeRuntime>,
      permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions',
      permissionType = 'bash'
    ) {
      const { runtime } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode, cwd: DIRECTORY });
      const consumed = consume(runtime.sendMessage(sessionId, 'run it', { cwd: DIRECTORY }));
      const connection = await openTurn(harness);
      connection.push(globalEvent(DIRECTORY, statusEvent(OC_SESSION_A, { type: 'busy' })));
      connection.push(
        globalEvent(
          DIRECTORY,
          partUpdated(toolPart(OC_SESSION_A, 'call_001', permissionType, toolStatePending()))
        )
      );
      connection.push(
        globalEvent(
          DIRECTORY,
          permissionUpdated(
            permission(OC_SESSION_A, {
              id: 'per_0001',
              type: permissionType,
              callID: 'call_001',
            })
          )
        )
      );
      return { sessionId, connection, ...consumed };
    }

    function finishTurn(connection: FakeConnection): void {
      connection.push(globalEvent(DIRECTORY, sessionIdle(OC_SESSION_A)));
    }

    it('forwards approval_required in default mode and approveTool responds once (never always)', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const { sessionId, connection, events, finished } = await turnWithPermission(
        harness,
        'default'
      );

      await vi.waitFor(() => expect(events.some((e) => e.type === 'approval_required')).toBe(true));
      const approval = events.find((e) => e.type === 'approval_required')!;
      expect(approval.data).toMatchObject({
        toolCallId: 'per_0001',
        toolName: 'bash',
        timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      });

      // alwaysAllow=true must still respond 'once' — 'always' would persist a
      // rule in OpenCode's own store (NOTES.md §2).
      expect(runtime.approveTool(sessionId, 'per_0001', true, true)).toBe(true);
      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'once' },
        })
      );

      // A second answer for the same permission finds nothing pending.
      expect(runtime.approveTool(sessionId, 'per_0001', true)).toBe(false);

      finishTurn(connection);
      await finished;
    });

    it('denies with reject and returns false for unknown interactions', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const { sessionId, events, connection, finished } = await turnWithPermission(
        harness,
        'default'
      );
      await vi.waitFor(() => expect(events.some((e) => e.type === 'approval_required')).toBe(true));

      expect(runtime.approveTool(sessionId, 'nope', false)).toBe(false);
      expect(runtime.approveTool(sessionId, 'per_0001', false)).toBe(true);
      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'reject' },
        })
      );

      finishTurn(connection);
      await finished;
    });

    it('auto-approves everything under bypassPermissions and suppresses the card', async () => {
      const harness = makeRuntime();
      const { client } = harness;
      const { connection, events, finished } = await turnWithPermission(
        harness,
        'bypassPermissions'
      );

      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'once' },
        })
      );

      finishTurn(connection);
      const all = await finished;
      expect(all.some((e) => e.type === 'approval_required')).toBe(false);
      expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    });

    it('auto-approves edit permissions under acceptEdits but still asks for bash', async () => {
      const harness = makeRuntime();
      const { client } = harness;

      // Edit-type permission: auto-approved, suppressed.
      const editTurn = await turnWithPermission(harness, 'acceptEdits', 'edit');
      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'once' },
        })
      );
      finishTurn(editTurn.connection);
      const editEvents = await editTurn.finished;
      expect(editEvents.some((e) => e.type === 'approval_required')).toBe(false);
    });

    it('asks the user for bash under acceptEdits (safe default)', async () => {
      const harness = makeRuntime();
      const { client } = harness;
      const bashTurn = await turnWithPermission(harness, 'acceptEdits', 'bash');
      await vi.waitFor(() =>
        expect(bashTurn.events.some((e) => e.type === 'approval_required')).toBe(true)
      );
      expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
      finishTurn(bashTurn.connection);
      await bashTurn.finished;
    });

    it('auto-denies a pending approval when the interaction timeout elapses', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const harness = makeRuntime();
      const { client } = harness;
      const { connection, events, finished } = await turnWithPermission(harness, 'default');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'approval_required')).toBe(true));

      await vi.advanceTimersByTimeAsync(SESSIONS.INTERACTION_TIMEOUT_MS + 1);

      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'reject' },
        })
      );

      finishTurn(connection);
      await finished;
    });

    it('a stale turn teardown leaves the newer turn pending approvals intact', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      // Turn A: drive it to its first yield manually so it can be abandoned.
      const turnA = runtime.sendMessage(sessionId, 'a', { cwd: DIRECTORY });
      const firstYieldA = turnA.next();
      const connection = await openTurn(harness);

      // Turn B races in and becomes the session's ACTIVE turn.
      const turnB = consume(runtime.sendMessage(sessionId, 'b', { cwd: DIRECTORY }));
      await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));

      // A permission arrives; both pipelines observe it (B's registration wins).
      connection.push(
        globalEvent(
          DIRECTORY,
          permissionUpdated(
            permission(OC_SESSION_A, { id: 'per_0001', type: 'bash', callID: 'call_001' })
          )
        )
      );
      const yieldedA = await firstYieldA;
      expect(yieldedA.done).toBe(false);
      expect((yieldedA.value as StreamEvent).type).toBe('approval_required');
      await vi.waitFor(() =>
        expect(turnB.events.some((e) => e.type === 'approval_required')).toBe(true)
      );

      // Stale teardown: abandoning turn A runs its finally — it must NOT
      // disarm turn B's auto-deny timer or orphan B's pending approval.
      await turnA.return(undefined);

      expect(runtime.approveTool(sessionId, 'per_0001', true)).toBe(true);
      await vi.waitFor(() =>
        expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
          path: { id: OC_SESSION_A, permissionID: 'per_0001' },
          body: { response: 'once' },
        })
      );

      finishTurn(connection);
      await turnB.finished;
    });

    it('clears the pending approval (and its deny timer) on a permission.replied echo', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const { sessionId, connection, events, finished } = await turnWithPermission(
        harness,
        'default'
      );
      await vi.waitFor(() => expect(events.some((e) => e.type === 'approval_required')).toBe(true));

      // Answered elsewhere (e.g. the OpenCode TUI) — the echo clears the card.
      connection.push(globalEvent(DIRECTORY, permissionReplied(OC_SESSION_A, 'per_0001')));
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'interaction_cancelled')).toBe(true)
      );

      // The auto-deny timer was disarmed with the record.
      await vi.advanceTimersByTimeAsync(SESSIONS.INTERACTION_TIMEOUT_MS + 1);
      expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
      expect(runtime.approveTool(sessionId, 'per_0001', true)).toBe(false);

      finishTurn(connection);
      await finished;
    });
  });

  describe('interrupt', () => {
    it('aborts the in-flight turn via session.abort and the turn ends with a quiet done', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();

      const { finished } = consume(runtime.sendMessage(sessionId, 'work', { cwd: DIRECTORY }));
      const connection = await openTurn(harness);
      connection.push(globalEvent(DIRECTORY, statusEvent(OC_SESSION_A, { type: 'busy' })));
      connection.push(globalEvent(DIRECTORY, partUpdated(textPart(OC_SESSION_A, 'prt_1', ''))));
      connection.push(globalEvent(DIRECTORY, partDelta(OC_SESSION_A, 'prt_1', 'partial')));

      await expect(runtime.interruptQuery(sessionId)).resolves.toBe(true);
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: OC_SESSION_A } });

      // The wire then carries the abort shape — suppressed, quiet done.
      connection.push(globalEvent(DIRECTORY, sessionError(OC_SESSION_A, abortedError())));
      connection.push(globalEvent(DIRECTORY, sessionIdle(OC_SESSION_A)));

      const events = await finished;
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(events[events.length - 1]!.type).toBe('done');
    });

    it('returns false when no turn is in flight', async () => {
      const { runtime } = makeRuntime();
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await expect(runtime.interruptQuery(sessionId)).resolves.toBe(false);
    });
  });

  describe('sidecar restart', () => {
    it('fails the in-flight turn with a typed error and resubscribes with a fresh client for the next turn', async () => {
      const harness = makeRuntime();
      const { runtime, client, provider } = harness;
      const sessionId = nextSessionId();

      // Turn 1: the stream dies mid-turn.
      const first = consume(runtime.sendMessage(sessionId, 'one', { cwd: DIRECTORY }));
      const connection1 = await openTurn(harness);
      connection1.push(globalEvent(DIRECTORY, partUpdated(textPart(OC_SESSION_A, 'p1', ''))));
      connection1.push(globalEvent(DIRECTORY, partDelta(OC_SESSION_A, 'p1', 'partial ')));
      connection1.fail(new Error('sidecar died'));

      const firstEvents = await first.finished;
      const errorEvent = firstEvents.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data).toMatchObject({ code: 'stream_error' });
      expect(firstEvents[firstEvents.length - 1]!.type).toBe('done');

      // Turn 2: catch → getClient() again → resubscribe → healthy stream.
      const eventCallsBefore = client.global.event.mock.calls.length;
      const second = consume(runtime.sendMessage(sessionId, 'two', { cwd: DIRECTORY }));
      await vi.waitFor(() =>
        expect(client.global.event.mock.calls.length).toBeGreaterThan(eventCallsBefore)
      );
      const connection2 = harness.source.latest();
      connection2.push(globalEvent(DIRECTORY, serverConnected()));
      await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
      for (const event of opencodeSimpleTurn(OC_SESSION_A, 'recovered')) {
        connection2.push(globalEvent(DIRECTORY, event));
      }

      const secondEvents = await second.finished;
      expect(secondEvents.some((e) => e.type === 'text_delta')).toBe(true);
      expect(secondEvents[secondEvents.length - 1]!.type).toBe('done');
      expect(secondEvents.some((e) => e.type === 'error')).toBe(false);
      // The reconnect went through the provider (fresh client), not a cache.
      expect(provider.getClient.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('session queries', () => {
    it('listSessions overlays DorkOS-tracked settings onto the sidecar listing', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'acceptEdits', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      // The sidecar lists the bound session — with no notion of a mode.
      client.session.list.mockResolvedValue({ data: [sessionInfo(OC_SESSION_A, DIRECTORY)] });

      const sessions = await runtime.listSessions(DIRECTORY);
      const bound = sessions.find((s) => s.id === sessionId);
      expect(bound).toBeDefined();
      expect(bound!.permissionMode).toBe('acceptEdits');
      expect(bound!.runtime).toBe('opencode');
      expect(bound!.title).toBe('fixture session');
    });

    it('keeps tracked-but-unlisted sessions visible (cold sidecar)', async () => {
      const { client } = createMockClient();
      const provider = createProvider(client);
      provider.peekClient.mockReturnValue(null); // cold — mapper lists []
      const runtime = new OpenCodeRuntime({ provider });
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      const sessions = await runtime.listSessions(DIRECTORY);
      expect(sessions.map((s) => s.id)).toContain(sessionId);

      const session = await runtime.getSession(DIRECTORY, sessionId);
      expect(session).not.toBeNull();
      expect(session!.runtime).toBe('opencode');
      await expect(runtime.getSession(DIRECTORY, nextSessionId())).resolves.toBeNull();
    });

    it('a cwd-less tracked session appears in NO project list (DOR-202)', async () => {
      const { client } = createMockClient();
      const provider = createProvider(client);
      provider.peekClient.mockReturnValue(null); // cold — mapper lists []
      const runtime = new OpenCodeRuntime({ provider });
      const sessionId = nextSessionId();
      // The PATCH-before-first-message path: updateSession auto-creates an
      // untracked id with no cwd. Pre-fix it fanned into EVERY project's list.
      await runtime.updateSession(sessionId, { permissionMode: 'acceptEdits' });

      await expect(runtime.listSessions(DIRECTORY)).resolves.toEqual([]);
      await expect(runtime.listSessions('/projects/other')).resolves.toEqual([]);
      // Still tracked: the first message floors its cwd at the default root
      // (sendMessage's DEFAULT_CWD fallback), which puts it on that list.
      expect(runtime.hasSession(sessionId)).toBe(true);
    });

    it('getMessageHistory delegates to the mapper and never throws', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      client.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              id: 'msg_u1',
              sessionID: OC_SESSION_A,
              role: 'user',
              time: { created: 1 },
              agent: 'build',
              model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
            },
            parts: [
              {
                id: 'prt_1',
                sessionID: OC_SESSION_A,
                messageID: 'msg_u1',
                type: 'text',
                text: 'hello',
              },
            ],
          },
        ],
      });
      const history = await runtime.getMessageHistory(DIRECTORY, sessionId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ role: 'user', content: 'hello' });

      // Sidecar unreachable → EventLog fallback ([] for a never-streamed id).
      client.session.messages.mockRejectedValue(new Error('down'));
      await expect(runtime.getMessageHistory(DIRECTORY, sessionId)).resolves.toEqual([]);
    });

    // Cross-runtime kickoff-suppression evidence (agent-creation-redesign M4).
    // The client fires the auto-first-turn kickoff runtime-blind, so an OpenCode
    // session gets one too. FINDING (verified here): OpenCode delivers the
    // additional-context bag as a SEPARATE `synthetic: true` text part, and the
    // mapper drops synthetic user parts from projected history (`mapHistoryMessage`).
    // So the first user record OpenCode returns is the PRISTINE
    // `<dork-kickoff>…</dork-kickoff>` envelope with no wrapper — exactly the shape
    // `filterKickoffHistory` suppresses. No leak, no per-runtime stripping needed;
    // this test is the regression armor for that mapping.
    it('maps the kickoff to a bare envelope (synthetic context dropped) that the filter suppresses', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      const envelope = wrapKickoff(
        'Read your SOUL.md and introduce yourself. Offer a first action.'
      );
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { id: 'msg_u1', sessionID: OC_SESSION_A, role: 'user', time: { created: 1 } },
            parts: [
              // The injected additional-context bag rides a synthetic part…
              {
                id: 'prt_ctx',
                sessionID: OC_SESSION_A,
                messageID: 'msg_u1',
                type: 'text',
                text: '<gen_ui>\n…teaching block…\n</gen_ui>\n\n<git_status>\n{}\n</git_status>',
                synthetic: true,
              },
              // …and the user content (the pristine envelope) is its own part.
              {
                id: 'prt_kick',
                sessionID: OC_SESSION_A,
                messageID: 'msg_u1',
                type: 'text',
                text: envelope,
              },
            ],
          },
          {
            info: {
              id: 'msg_a1',
              sessionID: OC_SESSION_A,
              role: 'assistant',
              time: { created: 2 },
            },
            parts: [
              {
                id: 'prt_a',
                sessionID: OC_SESSION_A,
                messageID: 'msg_a1',
                type: 'text',
                text: "Hi — I'm Keeper.",
              },
            ],
          },
        ],
      });

      const history = await runtime.getMessageHistory(DIRECTORY, sessionId);
      // The synthetic context part is gone; the first user record is the bare envelope.
      const firstUser = history.find((m) => m.role === 'user');
      expect(firstUser?.content).toBe(envelope);
      expect(firstUser?.content).not.toContain('git_status');

      // The shared seam drops exactly that record; the greeting survives.
      const filtered = filterKickoffHistory(history);
      expect(filtered.some((m) => m.role === 'user')).toBe(false);
      expect(filtered.some((m) => m.role === 'assistant')).toBe(true);
      expect(JSON.stringify(filtered)).not.toContain('dork-kickoff');
    });

    it('keeps a genuine first message that merely mentions the kickoff tag (no over-suppression)', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { id: 'msg_u1', sessionID: OC_SESSION_A, role: 'user', time: { created: 1 } },
            parts: [
              {
                id: 'prt_1',
                sessionID: OC_SESSION_A,
                messageID: 'msg_u1',
                type: 'text',
                text: 'what does <dork-kickoff> mean?',
              },
            ],
          },
        ],
      });

      const history = await runtime.getMessageHistory(DIRECTORY, sessionId);
      // A partial-tag mention is genuine content and passes through untouched.
      expect(filterKickoffHistory(history)).toEqual(history);
      expect(history[0]).toMatchObject({ role: 'user', content: 'what does <dork-kickoff> mean?' });
    });

    it('renameSession persists the title to the sidecar store', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      await runtime.renameSession(sessionId, 'New title', DIRECTORY);
      expect(client.session.update).toHaveBeenCalledWith({
        path: { id: OC_SESSION_A },
        body: { title: 'New title' },
      });
    });

    it('forkSession branches natively and adopts the fork under a derived id', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });
      await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

      const forked = await runtime.forkSession(DIRECTORY, sessionId, {
        upToMessageId: 'msg_0007',
      });
      expect(client.session.fork).toHaveBeenCalledWith({
        path: { id: OC_SESSION_A },
        body: { messageID: 'msg_0007' },
      });
      expect(forked).not.toBeNull();
      expect(forked!.runtime).toBe('opencode');
      expect(forked!.id).not.toBe(sessionId);

      // Unbound source → null, per the AgentRuntime contract.
      await expect(runtime.forkSession(DIRECTORY, nextSessionId())).resolves.toBeNull();
    });

    it('updateSession writes through the settings port and updates the overlay', async () => {
      const harness = makeRuntime();
      const { runtime, settingsPort } = harness;
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      await expect(
        runtime.updateSession(sessionId, { permissionMode: 'bypassPermissions' })
      ).resolves.toBe(true);
      expect(settingsPort.saveSessionSettings).toHaveBeenCalledWith(sessionId, {
        permissionMode: 'bypassPermissions',
      });

      const sessions = await runtime.listSessions(DIRECTORY);
      expect(sessions.find((s) => s.id === sessionId)!.permissionMode).toBe('bypassPermissions');
    });
  });

  describe('capabilities and models', () => {
    it('declares the verified OpenCode capabilities exactly', () => {
      const { runtime } = makeRuntime();
      const capabilities = runtime.getCapabilities();
      expect(capabilities).toBe(OPENCODE_CAPABILITIES);
      expect(capabilities).toMatchObject({
        type: 'opencode',
        supportsToolApproval: true,
        supportsCostTracking: true,
        supportsResume: true,
        supportsMcp: false,
        supportsQuestionPrompt: false,
        supportsPlugins: false,
        nativeContext: [],
      });
      expect(capabilities.permissionModes.supported).toBe(true);
      expect(capabilities.permissionModes.default).toBe('default');
      expect(capabilities.permissionModes.values.map((v) => v.id)).toEqual([
        'default',
        'acceptEdits',
        'bypassPermissions',
      ]);
    });

    it('projects the provider catalog into provider-scoped model options', async () => {
      const harness = makeRuntime();
      const { runtime, client } = harness;
      client.provider.list.mockResolvedValue({
        data: {
          all: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              env: [],
              models: {
                'claude-sonnet-4-5': {
                  id: 'claude-sonnet-4-5',
                  name: 'Claude Sonnet 4.5',
                  release_date: '2025-09-29',
                  attachment: true,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 200_000, output: 64_000 },
                  options: {},
                },
              },
            },
            {
              id: 'ollama',
              name: 'Ollama',
              env: [],
              models: {
                'llama3.3:70b': {
                  id: 'llama3.3:70b',
                  name: 'Llama 3.3 70B',
                  release_date: '2024-12-06',
                  attachment: false,
                  reasoning: false,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 128_000, output: 8_192 },
                  options: {},
                },
              },
            },
          ],
          default: { anthropic: 'claude-sonnet-4-5' },
          connected: ['anthropic', 'ollama'],
        },
      });

      const models = await runtime.getSupportedModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        value: 'anthropic/claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        description: 'Anthropic · claude-sonnet-4-5',
        isDefault: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        provider: 'anthropic',
      });
      expect(models[1]).toMatchObject({ value: 'ollama/llama3.3:70b', provider: 'ollama' });
      expect(models[1]!.isDefault).toBeUndefined();
    });

    it('returns an empty model list when the sidecar is unreachable', async () => {
      const provider = createProvider(null);
      const runtime = new OpenCodeRuntime({ provider });
      await expect(runtime.getSupportedModels()).resolves.toEqual([]);
    });
  });

  describe('session list stream', () => {
    it('subscribeSessionList yields the tracked inventory then live upserts', async () => {
      const { runtime } = makeRuntime();
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: DIRECTORY });

      const iterator = runtime
        .subscribeSessionList({ permissionMode: 'default', cwd: DIRECTORY })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        type: 'session_upserted',
        session: { id: sessionId, runtime: 'opencode' },
      });

      const next = iterator.next();
      await runtime.renameSession(sessionId, 'Renamed', DIRECTORY).catch(() => undefined);
      const upsert = await next;
      expect(upsert.value).toMatchObject({
        type: 'session_upserted',
        session: { id: sessionId, title: 'Renamed' },
      });
      await iterator.return?.();
    });
  });
});
