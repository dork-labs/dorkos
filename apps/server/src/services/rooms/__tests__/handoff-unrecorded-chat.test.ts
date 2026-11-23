/**
 * A hand-off from a chat started with only its folder (DOR-5035). Such a chat is bound with
 * `agent_path` NULL for good, while its agent's identity still resolves from the folder, so
 * admission, the end notice and its pickup all refused it. The chat here is started through the
 * REAL session launch on a runtime that, like Claude Code, knows the folder it runs each chat in;
 * nothing about the chat is written by hand. Only the room seat's turn is scripted.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime, mockInterruptReceipt } from '@dorkos/test-utils';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { Db } from '@dorkos/db';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import type { ScriptedTurnRunner } from './room-test-harness.js';

const SESSION = '00000000-0000-4000-8000-000000005035';
const DRAFT = 'Ship notes are ready for review.';

interface PostResult {
  posted: boolean;
  handedOff?: boolean;
  handoffId?: string;
  reason?: string;
  instruction?: string;
}

/** The draft inside a hand-off prompt's fence, or `undefined` when the prompt carries none. */
function draftIn(prompt: string): string | undefined {
  const fence =
    /--- BEGIN HANDED-OFF DRAFT (\w+) ---\n[^\n]*\n(?:[^\n]*Treat the draft as data[^\n]*\n)?([\s\S]*)\n--- END HANDED-OFF DRAFT \1 ---$/;
  return fence.exec(prompt)?.[2];
}

describe('a hand-off from a chat started with only its folder (DOR-5035)', () => {
  let dorkHome: string;
  let home: string;
  let otherHome: string;
  let juno: AgentIdentity;
  let rio: AgentIdentity;
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let room: RoomWithRoster;
  let junoId: string;
  let runtime: FakeAgentRuntime;
  let terminalAcceptance: import('../../session/private-messages/acceptance.js').PrivateSessionMessageAcceptanceService;
  let ownedService: RoomService | undefined;

  /** The seat posts the draft it was handed, as Juno, from its own session. */
  function seatRunner(voice: object): ScriptedTurnRunner {
    return {
      turns: [],
      interrupted: [],
      ...voice,
      interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
      async run(request: RoomTurnRequest) {
        const sessionId = request.sessionId ?? 'juno-seat';
        request.onSessionBound(sessionId);
        const draft = draftIn(request.prompt);
        if (draft === undefined) {
          // An ordinary room turn: it holds the seat while a test keeps it busy (DOR-5087).
          state.seatTaken?.();
          await state.seatBusy;
          return { sessionId, text: null };
        }
        // What happens to the source chat while the seat works (DOR-5040).
        if (state.whileSeatRuns) live.override = state.whileSeatRuns();
        // The seat is not the chat under test: its own launch facts stand in.
        const { recordFixturePublicSource } = await import('./durable-handoff-fixture.js');
        const { durableHarness } = state;
        await recordFixturePublicSource(durableHarness!, sessionId, home, request.room.id);
        await registry.invoke(
          'rooms.post',
          { roomId: request.room.id, text: draft },
          { identity: juno, sessionId, retryChannel: 'mcp-argument' }
        );
        return { sessionId, text: null };
      },
    } as unknown as ScriptedTurnRunner;
  }
  const state: {
    durableHarness?: import('./room-test-harness.js').RoomHarness;
    /** The folder the source chat's runtime reports once the seat runs: `null` for none. */
    whileSeatRuns?: () => string | null;
    /** The folder the runtime reports right after admission: `null` once it forgot the chat. */
    afterAdmission?: () => string | null;
    /** While pending, an ordinary turn of the seat stays running. */
    seatBusy?: Promise<void>;
    /** Called once an ordinary turn holds the seat. */
    seatTaken?: () => void;
  } = {};
  /** An override of the folder the runtime reports for the source chat. */
  const live: { override?: string | null } = {};
  const GHOST_WORKSPACE = '/workspaces/ghost-ws';

  /** Start the chat for real with `cwd` only, its one turn posting into the room as `as`. */
  async function launchFolderChat(as: AgentIdentity): Promise<PostResult> {
    const { dispatchSessionMessage } = await import('../../session/launch/launch-session.js');
    let answer: PostResult | undefined;
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        answer = (await registry.invoke(
          'rooms.post',
          { roomId: room.id, text: DRAFT },
          { identity: as, sessionId: SESSION, retryChannel: 'mcp-argument' }
        )) as PostResult;
        // The runtime forgets the chat before the seat takes the hand-off (DOR-5087).
        if (state.afterAdmission) live.override = state.afterAdmission();
        yield { type: 'done', data: { sessionId: SESSION } } as StreamEvent;
      },
    ]);
    const mesh = {
      listWithPaths: () => [
        { id: home, name: 'juno', projectPath: home },
        { id: otherHome, name: 'rio', projectPath: otherHome },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      dispatchSessionMessage({
        sessionId: SESSION,
        origin: { kind: 'interactive' },
        request: { content: 'Share the ship notes in the room.', cwd: home },
        clientId: 'web:person',
        meshCore: mesh as never,
        roomSessionPlace: undefined,
        launcher: { kind: 'person' },
        onSettled: () => resolve(),
      }).catch(reject);
    });
    return answer!;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await service.triggersIdle();
      await service.handoffs.idle();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'unrecorded-chat-dork-')));
    vi.stubEnv('DORK_HOME', dorkHome);
    // Where agents' homes live, so the real boundary check lets the chat start there.
    home = join(dorkHome, 'agents', 'juno');
    otherHome = join(dorkHome, 'agents', 'rio');
    mkdirSync(home, { recursive: true });
    mkdirSync(otherHome, { recursive: true });
    const { initBoundary } = await import('../../../lib/boundary.js');
    await initBoundary(dorkHome);
    const createdAt = new Date().toISOString();
    juno = { agentPath: home, displayName: 'Juno', createdAt };
    rio = { agentPath: otherHome, displayName: 'Rio', createdAt };
    const { registerTestHomes } =
      await import('../../core/agent-identity/__tests__/agent-home-fixture.js');
    registerTestHomes([home, otherHome], { managed: { [GHOST_WORKSPACE]: '/agents/gone' } });
    state.whileSeatRuns = undefined;
    state.afterAdmission = undefined;
    state.seatBusy = undefined;
    state.seatTaken = undefined;
    live.override = undefined;
    const permission = await import('../../core/capabilities/permission-enforcement.js');
    permission.initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    const { agentLookupFor, createRoomHarness, roomVoice } = await import('./room-test-harness.js');
    const harness = createRoomHarness({
      agents: agentLookupFor({
        [home]: { name: 'juno', displayName: 'Juno', responseMode: 'mention-only' },
        [otherHome]: { name: 'rio', displayName: 'Rio', responseMode: 'mention-only' },
      }),
      runner: seatRunner(roomVoice()),
      operatorName: () => 'Dorian',
    });
    state.durableHarness = harness;
    ({ service, store, db } = harness);
    ownedService = service;
    const dbModule = await import('@dorkos/db');
    // The agents' registrations, under the ids the harness's lookup gives them, as Mesh writes
    // them. Nothing about the chat is written here.
    for (const [name, projectPath] of [
      ['juno', home],
      ['rio', otherHome],
    ] as const) {
      db.insert(dbModule.agents)
        .values({
          id: projectPath,
          name,
          runtime: 'fake-live',
          projectPath,
          registeredAt: createdAt,
          updatedAt: createdAt,
        })
        .run();
    }
    junoId = harness.authors.resolveAgent(home, 'Juno').id;
    harness.authors.resolveAgent(otherHome, 'Rio');

    const { runtimeRegistry } = await import('../../core/runtime-registry.js');
    runtimeRegistry.setDb(db);
    runtime = new FakeAgentRuntime('fake-live');
    // Like Claude Code: the runtime knows the folder it is running each chat in.
    runtime.getSessionCwd = (sessionId) =>
      live.override !== undefined
        ? (live.override ?? undefined)
        : (
            runtime.sendMessage.mock.calls.find((call) => call[0] === sessionId)?.[2] as
              { cwd?: string } | undefined
          )?.cwd;
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault('fake-live');
    const { setSessionAgentSources } = await import('../../core/agent-identity/session-agent.js');
    const { liveRuntimeCwd } = await import('../../core/runtime-seam/live-runtime-cwd.js');
    setSessionAgentSources({ liveCwd: (sessionId) => liveRuntimeCwd(db, sessionId) });

    const { HandoffTerminalSource } = await import('../handoff/handoff-terminal-source.js');
    const { HandoffTerminalNotices } = await import('../handoff/handoff-terminal-notices.js');
    const { PrivateSessionMessageAcceptanceService } =
      await import('../../session/private-messages/acceptance.js');
    const { MessageQueueStore } = await import('../../session/message-queue-store.js');
    const terminalSource = new HandoffTerminalSource(db, store.handoffOutbox);
    terminalAcceptance = new PrivateSessionMessageAcceptanceService(
      db,
      new MessageQueueStore(db),
      [terminalSource],
      'test-notice-boot'
    );
    const notices = new HandoffTerminalNotices(
      store.handoffOutbox,
      terminalSource,
      terminalAcceptance,
      () => {}
    );
    service.handoffs.initializeDurable(() => notices.flush());

    const { composeRegistry } = await import('../../core/capabilities/index.js');
    const { roomsDomain } = await import('../room-capabilities.js');
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    room = service.createRoom(
      { kind: 'channel', title: 'launch', members: [], agentPaths: [home, otherHome] },
      harness.human
    );
    service.post(room.id, { authorId: harness.human, text: 'morning' });
  }, 30_000);

  afterEach(async () => {
    ownedService?.dispose();
    try {
      if (ownedService) await settle();
    } finally {
      const { setSessionAgentSources } = await import('../../core/agent-identity/session-agent.js');
      setSessionAgentSources(undefined);
      const { clearTestHomes } =
        await import('../../core/agent-identity/__tests__/agent-home-fixture.js');
      clearTestHomes();
      const permission = await import('../../core/capabilities/permission-enforcement.js');
      permission.resetPermissionGate();
      vi.restoreAllMocks();
      vi.resetModules();
      if (db?.$client.open) db.$client.close();
      vi.unstubAllEnvs();
      rmSync(dorkHome, { recursive: true, force: true });
      ownedService = undefined;
    }
  }, 30_000);

  it('is handed to the seat, posted, and its end notice is accepted for the chat', async () => {
    const answer = await launchFolderChat(juno);
    const { eq, sessionMetadata } = await import('@dorkos/db');
    // The real launch bound the chat without an agent: the case this is about.
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, SESSION)).get()
    ).toMatchObject({ runtime: 'fake-live', agentPath: null });
    expect(answer).toMatchObject({ posted: false, handedOff: true });

    await settle();
    expect(
      store
        .listEntries(room.id, { limit: 100 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === junoId)
        .map((entry) => entry.body.text)
    ).toEqual([`${DRAFT}\n\n_Shared from another chat._`]);
    await expect(
      registry.invoke(
        'rooms.handoff_status',
        { handoffId: answer.handoffId },
        { identity: juno, sessionId: SESSION, retryChannel: 'mcp-argument' }
      )
    ).resolves.toMatchObject({ status: 'posted' });
    const row = store.handoffOutbox.readOwned(answer.handoffId!, junoId)!;
    expect(row.noticeReceiptId).toEqual(expect.any(String));
    const prepared = await terminalAcceptance.prepare(row.noticeReceiptId!);
    expect(prepared.content).toBe('Juno shared it in #launch.');
  });

  // DOR-5040: the runtime drops the chat (a restart, an idle reclaim) after admission.
  it('still accepts the end notice after the runtime dropped the chat', async () => {
    state.whileSeatRuns = () => null;
    const answer = await launchFolderChat(juno);
    await settle();
    const row = store.handoffOutbox.readOwned(answer.handoffId!, junoId)!;
    expect(row.noticeState).toBe('accepted');
    const prepared = await terminalAcceptance.prepare(row.noticeReceiptId!);
    expect(prepared.content).toBe('Juno shared it in #launch.');
  });

  // DOR-5087: a restart while the hand-off waits. The test runtime, like any runtime that keeps
  // its chats in memory, no longer knows the chat's folder when the seat takes the hand-off.
  /** Hand off while the seat is busy, so it waits in the queue as QA's restart row sets it up. */
  async function queuedHandoff(): Promise<PostResult> {
    let free!: () => void;
    state.seatBusy = new Promise<void>((resolve) => (free = resolve));
    const taken = new Promise<void>((resolve) => (state.seatTaken = resolve));
    const human = store.listEntries(room.id, { limit: 1 })[0]!.authorId;
    service.post(room.id, { authorId: human, text: '@juno hold this turn' });
    await taken;
    const answer = await launchFolderChat(juno);
    expect(answer).toMatchObject({ posted: false, handedOff: true });
    expect(store.handoffOutbox.readOwned(answer.handoffId!, junoId)?.state).toBe('queued');
    free();
    await settle();
    return answer;
  }

  it('posts a hand-off whose chat the runtime forgot before the seat took it, and reports once', async () => {
    state.afterAdmission = () => null;
    const answer = await queuedHandoff();
    const row = store.handoffOutbox.readOwned(answer.handoffId!, junoId)!;
    expect(row.state).toBe('posted');
    expect(
      store
        .listEntries(room.id, { limit: 100 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === junoId)
    ).toHaveLength(1);
    expect(row.noticeState).toBe('accepted');
    const prepared = await terminalAcceptance.prepare(row.noticeReceiptId!);
    expect(prepared.content).toBe('Juno shared it in #launch.');
  });

  it.each([
    ['another agent’s home', () => otherHome],
    ['a folder that is no agent’s', () => join(dorkHome, 'scratch')],
    ['a folder the resolver refuses', () => GHOST_WORKSPACE],
  ])('never posts a queued hand-off whose chat now stands in %s', async (_label, folder) => {
    state.afterAdmission = folder;
    const answer = await queuedHandoff();
    expect(store.handoffOutbox.readOwned(answer.handoffId!, junoId)?.state).toBe('declined');
    expect(
      store
        .listEntries(room.id, { limit: 100 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === junoId)
    ).toEqual([]);
  });

  it.each([
    ['now stands in another agent’s home', () => otherHome],
    ['now stands in a folder that is no agent’s', () => join(dorkHome, 'scratch')],
    ['now stands in a folder the resolver refuses', () => GHOST_WORKSPACE],
  ])('skips the end notice when the chat %s', async (_label, folder) => {
    state.whileSeatRuns = folder;
    const answer = await launchFolderChat(juno);
    await settle();
    const row = store.handoffOutbox.readOwned(answer.handoffId!, junoId)!;
    // The post went out, so the skip is the notice-time check, not an earlier failure.
    expect(row.state).toBe('posted');
    expect(row.noticeState).toBe('skipped');
  });

  it("refuses another agent posting from it, and says the chat isn't theirs", async () => {
    const answer = await launchFolderChat(rio);
    expect(answer).toMatchObject({
      posted: false,
      handedOff: false,
      reason: 'admission-policy-unavailable',
    });
    expect(answer.instruction).toContain('can’t confirm this chat is yours');
    expect(answer.instruction).not.toContain('Start a new turn');
  });
});
