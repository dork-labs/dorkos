/** Real public Registry/RoomService/append+outbox/coordinator; fake external turn runner only. */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoomTurnRequest } from '../room-turn-port.js';
import type { RoomHarness, ScriptedTurnRunner } from './room-test-harness.js';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import type { HandoffTerminalSource } from '../handoff/handoff-terminal-source.js';
import type { HandoffTerminalNotices } from '../handoff/handoff-terminal-notices.js';
import type { PrivateSessionMessageAcceptanceService } from '../../session/private-messages/acceptance.js';
import type { Db } from '@dorkos/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
interface CompositionContext {
  db: Db;
  harness: RoomHarness;
  registry: CapabilityRegistry;
  runner: ScriptedTurnRunner & { requests: RoomTurnRequest[] };
  source: HandoffTerminalSource;
  acceptance: PrivateSessionMessageAcceptanceService;
  notices: HandoffTerminalNotices;
  nudged: string[];
}
async function load() {
  return {
    testing: await import('@dorkos/test-utils'),
    db: await import('@dorkos/db'),
    cap: await import('../../core/capabilities/index.js'),
    permission: await import('../../core/capabilities/permission-enforcement.js'),
    registry: await import('../../core/runtime-registry.js'),
    levels: await import('../../core/turn-power/turn-levels.js'),
    constants: await import('../../runtimes/claude-code/runtime-constants.js'),
    harness: await import('./room-test-harness.js'),
    domain: await import('../room-capabilities.js'),
    source: await import('../handoff/handoff-terminal-source.js'),
    notices: await import('../handoff/handoff-terminal-notices.js'),
    acceptance: await import('../../session/private-messages/acceptance.js'),
    queue: await import('../../session/message-queue-store.js'),
  };
}
let m: Awaited<ReturnType<typeof load>>, home: string, agentPath: string, file: string;
const handles: import('@dorkos/db').Db[] = [];
const services: import('../room-service.js').RoomService[] = [];
let recorder: AgentRuntime;
let script: (request: RoomTurnRequest, ctx: CompositionContext) => Promise<void>;
async function open(initialize = true): Promise<CompositionContext> {
  const db = m.db.createDb(file);
  handles.push(db);
  m.db.runMigrations(db); // Actual registered migration mandatory; no fake tableDDL.
  m.registry.runtimeRegistry.setDb(db);
  const runner: ScriptedTurnRunner & { requests: RoomTurnRequest[] } = {
    turns: [],
    requests: [],
    interrupted: [],
    ...m.harness.roomVoice(),
    interrupt: async () => m.testing.mockInterruptReceipt('not-running'),
    async run(request: RoomTurnRequest) {
      const sessionId = request.sessionId!;
      request.onSessionBound(sessionId);
      runner.requests.push(request);
      runner.turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        cwd: request.cwd,
        sessionId,
        prompt: request.prompt,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      await script(request, ctx);
      return { sessionId, text: null };
    },
  };
  const harness = m.harness.createRoomHarness({
    db,
    agents: m.harness.agentLookupFor({
      [agentPath]: {
        id: 'casey-agent',
        name: 'casey',
        displayName: 'Casey',
        responseMode: 'mention-only',
      },
    }),
    runner,
    operatorName: () => 'Owner',
  });
  services.push(harness.service);
  const registry = m.cap.composeRegistry([m.domain.roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: harness.service },
  });
  const source = new m.source.HandoffTerminalSource(db, harness.store.handoffOutbox);
  const acceptance = new m.acceptance.PrivateSessionMessageAcceptanceService(
    db,
    new m.queue.MessageQueueStore(db),
    [source],
    'notice-boot'
  );
  const nudged: string[] = [];
  const notices = new m.notices.HandoffTerminalNotices(
    harness.store.handoffOutbox,
    source,
    acceptance,
    (id) => {
      nudged.push(id);
    }
  );
  const ctx: CompositionContext = {
    db,
    harness,
    registry,
    runner,
    source,
    acceptance,
    notices,
    nudged,
  };
  if (initialize) harness.service.handoffs.initializeDurable(() => notices.flush());
  return ctx;
}
let f: CompositionContext, roomId: string, authorId: string;
async function record(session = 'caller') {
  for await (const event of recorder.sendMessage(session, 'local source fixture', {
    permissionCeiling: 'runtime-default',
  }))
    void event;
}
function identity() {
  return { agentPath, displayName: 'Casey', createdAt: new Date().toISOString() };
}
async function publish(request: RoomTurnRequest, ctx: CompositionContext) {
  await ctx.registry.invoke(
    'rooms.post',
    { roomId: request.room.id, text: 'One accepted answer', confirm: true },
    { identity: identity(), sessionId: request.sessionId ?? undefined, mcpServer: 'in-session' }
  );
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
  home = mkdtempSync(join(tmpdir(), 'durable-handoff-composition-'));
  agentPath = join(home, 'casey');
  mkdirSync(agentPath);
  file = join(home, 'owned.sqlite');
  vi.stubEnv('DORK_HOME', home);
  m = await load();
  m.permission.initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
  script = async () => {};
  f = await open(false);
  f.db
    .insert(m.db.agents)
    .values({
      id: 'casey-agent',
      name: 'casey',
      runtime: 'claude-code',
      projectPath: agentPath,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  const room = f.harness.service.createRoom(
    { kind: 'channel', title: 'Durable fixture', members: [], agentPaths: [agentPath] },
    f.harness.human
  );
  roomId = room.id;
  authorId = f.harness.authors.resolveAgent(agentPath, 'Casey').id;
  f.harness.service.post(roomId, { authorId: f.harness.human, text: 'Room context' });
  f.db
    .insert(m.db.sessionMetadata)
    .values({
      sessionId: 'caller',
      runtime: 'claude-code',
      agentPath,
      launchOrigin: 'interactive',
      createdAt: new Date().toISOString(),
    })
    .run();
  const fake = new m.testing.FakeAgentRuntime('claude-code');
  fake.getCapabilities.mockReturnValue(m.constants.CLAUDE_CODE_CAPABILITIES);
  recorder = m.levels.recordTurnLevels(fake, () => 'bypassPermissions');
  f.harness.service.handoffs.initializeDurable(() => f.notices.flush());
  await record();
  await f.harness.service.triggersIdle();
  f.runner.turns.length = 0;
  f.runner.requests.length = 0;
  script = publish;
}, 30_000);
afterEach(async () => {
  for (const service of services) service.dispose();
  try {
    for (const service of services) {
      await service.handoffs.idle();
      await service.triggersIdle();
    }
  } finally {
    m?.permission.resetPermissionGate();
    vi.resetModules();
    for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
    services.length = 0;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});
async function admitThenStop() {
  // Direct server entry calls the same real factory synchronously; stop before queue's promotion microtask.
  const pending = f.harness.service.handoffs.handOff({
    roomId,
    author: f.harness.authors.getMany([authorId]).get(authorId)!,
    text: 'Original draft @/never-read',
    verbatim: false,
    callerSessionId: 'caller',
  });
  f.harness.service.dispose();
  const result = await pending;
  await f.harness.service.handoffs.idle();
  expect(result.handoffId).toEqual(expect.any(String));
  return result.handoffId as string;
}
async function reopen() {
  f.harness.service.dispose();
  await f.harness.service.triggersIdle();
  f.db.$client.close();
  f = await open();
  await f.harness.service.handoffs.idle();
  return f;
}
describe('durable public handoff full composition', () => {
  it.each(['stop', 'crash'] as const)(
    'resumes the first hand-off waiting on a busy seat after %s',
    async (shutdown) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      script = async () => {
        await held;
      };
      try {
        f.harness.service.post(roomId, { authorId: f.harness.human, text: '@casey keep working' });
        await vi.waitFor(() => expect(f.runner.requests).toHaveLength(1));
        const receipt = await f.harness.service.handoffs.handOff({
          roomId,
          author: f.harness.authors.getMany([authorId]).get(authorId)!,
          text: 'Waiting for the occupied seat',
          verbatim: false,
          callerSessionId: 'caller',
        });
        const id = receipt.handoffId as string;
        await vi.waitFor(() =>
          expect(f.harness.service.handoffs.status(id, authorId)).toMatchObject({
            status: 'pending',
            waiting: 'seat_busy',
          })
        );
        expect(f.runner.requests).toHaveLength(1);
        expect(f.harness.store.handoffOutbox.readOwned(id, authorId)?.state).toBe('queued');
        if (shutdown === 'stop') f.harness.service.dispose();
        script = publish;
        const restored = await open();
        await restored.harness.service.handoffs.idle();
        expect(restored.harness.service.handoffs.status(id, authorId)).toMatchObject({
          status: 'posted',
        });
        expect(restored.runner.requests).toHaveLength(1);
      } finally {
        f.harness.service.dispose();
        release();
        await f.harness.service.handoffs.idle();
        await f.harness.service.triggersIdle();
      }
    }
  );
  it('skips a terminal ready row whose valid origin names a different real seat room and caller', async () => {
    const source = f.harness.service.createRoom(
      { kind: 'channel', title: 'Actual original', members: [], agentPaths: [agentPath] },
      f.harness.human
    );
    const other = f.harness.service.createRoom(
      { kind: 'channel', title: 'Independent room', members: [], agentPaths: [agentPath] },
      f.harness.human
    );
    f.harness.store.bindRoomSession(source.id, authorId, 'caller', new Date().toISOString());
    f.harness.store.bindRoomSession(other.id, authorId, 'other-caller', new Date().toISOString());
    f.db
      .update(m.db.sessionMetadata)
      .set({ launchOrigin: 'room' })
      .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
      .run();
    f.db
      .insert(m.db.sessionMetadata)
      .values({
        sessionId: 'other-caller',
        runtime: 'claude-code',
        agentPath,
        launchOrigin: 'room',
        createdAt: new Date().toISOString(),
      })
      .run();
    f.db.$client
      .exec(`CREATE TRIGGER hold_original_notice BEFORE UPDATE OF notice_room_entry_id ON room_handoff_outbox
   WHEN NEW.notice_room_entry_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'retain ready row for corruption control'); END`);
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Original public request' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    const row = f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)!;
    expect(row).toMatchObject({ state: 'posted', noticeState: 'ready' });
    const origin = JSON.parse(row.originJson);
    const independentMember = f.harness.store.getMember(other.id, authorId)!;
    // Every individual routing fact exists; only the immutable admission caller correlation is false.
    f.db
      .update(m.db.roomHandoffOutbox)
      .set({
        originJson: JSON.stringify({
          ...origin,
          sessionId: 'other-caller',
          roomId: other.id,
          memberJoinedAt: independentMember.joinedAt,
        }),
      })
      .where(m.db.eq(m.db.roomHandoffOutbox.id, result.handoffId))
      .run();
    f.db.$client.exec('DROP TRIGGER hold_original_notice');
    f.harness.service.handoffs.flushTerminals();
    f.notices.flush();
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      noticeState: 'skipped',
      noticeRoomEntryId: null,
      noticeReceiptId: null,
    });
    for (const id of [source.id, other.id])
      expect(
        f.harness.store
          .listEntries(id, { limit: 30 })
          .filter((entry) => entry.body.notice === 'handoff_shared')
      ).toHaveLength(0);
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(0);
    expect(f.runner.turns).toHaveLength(1);
  });
  it('retains the original room SYSTEM notice with an atomic durable entry receipt and no private fallback', async () => {
    const sourceRoom = f.harness.service.createRoom(
      { kind: 'channel', title: 'Original source', members: [], agentPaths: [agentPath] },
      f.harness.human
    );
    f.harness.store.bindRoomSession(sourceRoom.id, authorId, 'caller', new Date().toISOString());
    f.db
      .update(m.db.sessionMetadata)
      .set({ launchOrigin: 'room' })
      .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
      .run();
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Original public request' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    const row = f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)!;
    expect(row).toMatchObject({
      state: 'posted',
      noticeState: 'accepted',
      noticeRoomEntryId: `handoff-notice-${result.handoffId}`,
    });
    const notices = () =>
      f.harness.store
        .listEntries(sourceRoom.id, { limit: 30 })
        .filter((entry) => entry.body.notice === 'handoff_shared');
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.seq).toBe(row.noticeRoomSeq);
    const destination = f.harness.store.getRoom(roomId)!;
    expect(notices()[0]?.body.text).toBe(
      `Casey shared it in ${destination.slug ? `#${destination.slug}` : destination.title}.`
    );
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(0);
    f.harness.service.handoffs.flushTerminals();
    await reopen();
    f.harness.service.handoffs.flushTerminals();
    expect(notices()).toHaveLength(1);
    expect(f.runner.turns).toHaveLength(0);
  });
  it('rolls back a SYSTEM append when its notice CAS write fails, then retries exactly once through the maintenance port', async () => {
    const sourceRoom = f.harness.service.createRoom(
      { kind: 'channel', title: 'Original source', members: [], agentPaths: [agentPath] },
      f.harness.human
    );
    f.harness.store.bindRoomSession(sourceRoom.id, authorId, 'caller', new Date().toISOString());
    f.db
      .update(m.db.sessionMetadata)
      .set({ launchOrigin: 'room' })
      .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
      .run();
    // Fault injection into the real generated table; no replacement table or authority mock.
    f.db.$client
      .exec(`CREATE TRIGGER reject_room_notice BEFORE UPDATE OF notice_room_entry_id ON room_handoff_outbox
   WHEN NEW.notice_room_entry_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned notice write fault'); END`);
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Original public request' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    const notices = () =>
      f.harness.store
        .listEntries(sourceRoom.id, { limit: 30 })
        .filter((entry) => entry.body.notice === 'handoff_shared');
    expect(notices()).toHaveLength(0);
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      state: 'posted',
      noticeState: 'ready',
      noticeRoomEntryId: null,
    });
    expect(f.runner.turns).toHaveLength(1);
    f.db.$client.exec('DROP TRIGGER reject_room_notice');
    f.harness.service.handoffs.flushTerminals();
    f.harness.service.handoffs.flushTerminals();
    expect(notices()).toHaveLength(1);
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      noticeState: 'accepted',
    });
    expect(f.runner.turns).toHaveLength(1);
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(0);
  });
  it('keeps startup available when a retained terminal notice has a transient storage fault', async () => {
    f.db.$client
      .exec(`CREATE TRIGGER startup_notice_fault BEFORE INSERT ON session_message_acceptance_receipts
   WHEN NEW.source_kind='room_handoff_terminal' BEGIN SELECT RAISE(ABORT,'owned startup receipt fault'); END`);
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'An accepted draft' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      state: 'posted',
      noticeState: 'ready',
    });
    f.harness.service.dispose();
    await f.harness.service.triggersIdle();
    const rebuilt = await open(false);
    expect(() =>
      rebuilt.harness.service.handoffs.initializeDurable(() => rebuilt.notices.flush())
    ).not.toThrow();
    expect(rebuilt.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject(
      { noticeState: 'ready' }
    );
    rebuilt.db.$client.exec('DROP TRIGGER startup_notice_fault');
    rebuilt.harness.service.handoffs.flushTerminals();
    expect(rebuilt.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
  it('retries a transient private acceptance failure without a new handoff, restart, or model replay', async () => {
    f.db.$client
      .exec(`CREATE TRIGGER reject_handoff_receipt BEFORE INSERT ON session_message_acceptance_receipts
   WHEN NEW.source_kind='room_handoff_terminal' BEGIN SELECT RAISE(ABORT,'owned receipt write fault'); END`);
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Original public request' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      state: 'posted',
      noticeState: 'ready',
      noticeReceiptId: null,
    });
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(0);
    expect(f.runner.turns).toHaveLength(1);
    f.db.$client.exec('DROP TRIGGER reject_handoff_receipt');
    // This is the exact public port called by the existing health-maintenance callback.
    f.harness.service.handoffs.flushTerminals();
    f.harness.service.handoffs.flushTerminals();
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId)).toMatchObject({
      noticeState: 'accepted',
    });
    expect(f.runner.turns).toHaveLength(1);
  });
  it('actual parsed registry admission commits frozen source before ID receipt and posts through atomic actual writer', async () => {
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Original draft', callerSessionId: 'forged', turnSerial: 999 },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    const admitted = f.harness.store.handoffOutbox.readOwned(result.handoffId, authorId);
    expect(admitted?.envelopeJson).toContain('"callerSessionId":"caller"');
    expect(admitted?.envelopeJson).toContain('"outsideWords":true');
    await f.harness.service.handoffs.idle();
    expect(f.harness.service.handoffs.status(result.handoffId, authorId)).toMatchObject({
      status: 'posted',
    });
    expect(f.runner.turns).toHaveLength(1);
    expect(f.runner.requests[0]?.untrustedText).toBe(true);
    expect(f.runner.requests[0]?.outsideWords).toBe(true);
    expect(f.runner.requests[0]?.externalAuthor).toBe(true);
    expect(f.runner.requests[0]?.carriedOutsider).toBe(true);
    expect(JSON.parse(admitted!.envelopeJson).recipient.createdAt).toBe('2026-11-16T12:00:00.000Z');
    const receipt = f.db.select().from(m.db.sessionMessageAcceptanceReceipts).get()!;
    const claimed = f.acceptance.claim(receipt.id, await f.acceptance.prepare(receipt.id), {
      sessionId: 'caller',
      runtime: 'claude-code',
    });
    expect(claimed).toMatchObject({
      roomHandoffCarry: { outsideWords: true, outsider: true, externalAuthor: true },
    });
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(
      f.harness.store.listEntries(roomId, { limit: 20 }).filter((e) => e.authorId === authorId)
    ).toHaveLength(1);
  });
  it('process stop preserves queued original deadline/carry/epoch, actual reopen runs once and accepts one terminal receipt', async () => {
    const id = await admitThenStop();
    const before = f.harness.store.handoffOutbox.readOwned(id, authorId)!;
    expect(before.state).toBe('queued');
    expect(f.runner.turns).toHaveLength(0);
    await reopen();
    const after = f.harness.store.handoffOutbox.readOwned(id, authorId)!;
    expect(after.envelopeJson).toBe(before.envelopeJson);
    expect(after.waitDeadlineAt).toBe(before.waitDeadlineAt);
    expect(after.state).toBe('posted');
    expect(f.runner.turns).toHaveLength(1);
    f.notices.flush();
    f.notices.flush();
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
  it('replays a queued outsider-marked hand-off after restart with the same marks a live one gets', async () => {
    const marksOf = (request: RoomTurnRequest) => ({
      outsideWords: request.outsideWords,
      externalAuthor: request.externalAuthor,
      carriedOutsider: request.carriedOutsider,
      teammate: request.teammate,
      permissionCeiling: request.permissionCeiling,
    });
    // The same drafting turn, handed off live with no restart.
    const live = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Live draft' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    expect(f.harness.service.handoffs.status(live.handoffId, authorId)).toMatchObject({
      status: 'posted',
    });
    const liveMarks = marksOf(f.runner.requests.at(-1)!);
    // The drafting turn ran at the runtime default, a stranger's bound, so it is marked.
    expect(liveMarks).toMatchObject({
      outsideWords: true,
      externalAuthor: true,
      carriedOutsider: true,
    });
    const id = await admitThenStop();
    const saved = JSON.parse(f.harness.store.handoffOutbox.readOwned(id, authorId)!.envelopeJson);
    expect(saved.carry).toMatchObject({ outsider: true, outsideWords: true, externalAuthor: true });
    await reopen();
    expect(f.runner.requests).toHaveLength(1);
    expect(marksOf(f.runner.requests[0]!)).toEqual(liveMarks);
  });
  it.each(['preparing', 'running'] as const)(
    'boot never replays ambiguous %s model work',
    async (state) => {
      const id = await admitThenStop();
      const row = f.harness.store.handoffOutbox.readOwned(id, authorId)!;
      f.harness.store.handoffOutbox.claimQueued(
        id,
        row.envelopeJson,
        'prior-boot',
        Date.now(),
        () => {}
      );
      if (state === 'running')
        f.harness.store.handoffOutbox.markRunning(id, 'prior-boot', 'prior-dispatch', Date.now());
      await reopen();
      expect(f.runner.turns).toHaveLength(0);
      expect(f.harness.store.handoffOutbox.readOwned(id, authorId)).toMatchObject({
        state: 'interrupted',
      });
      expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    }
  );
  it('restart after original deadline expires without model or renewed clock', async () => {
    const id = await admitThenStop();
    const deadline = f.harness.store.handoffOutbox.readOwned(id, authorId)!.waitDeadlineAt;
    vi.setSystemTime(deadline);
    await reopen();
    expect(f.runner.turns).toHaveLength(0);
    expect(f.harness.store.handoffOutbox.readOwned(id, authorId)).toMatchObject({
      state: 'expired',
      waitDeadlineAt: deadline,
    });
  });
  it('actual append survives missing post-commit notePosted and reboot without duplicate room post', async () => {
    script = async (request, ctx) => {
      const owner = ctx.harness.service.handoffs.runningFor(roomId, authorId);
      if (!owner) throw new Error('Missing real running owner');
      ctx.harness.service.postFromTool(
        roomId,
        {
          authorId,
          text: 'Committed before crash',
          callerSessionId: request.sessionId ?? undefined,
          callerAgentVerified: true,
        },
        ctx.harness.service.handoffs.bindPosted(owner)
      );
      // Deliberately omit after-commit notePosted: durable bind, not memory, must prove the outcome.
      throw new Error('Process lost response after append');
    };
    const result = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Draft' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    )) as { handoffId: string };
    await f.harness.service.handoffs.idle();
    expect(f.harness.service.handoffs.status(result.handoffId, authorId)).toMatchObject({
      status: 'posted',
    });
    f.harness.service.dispose();
    await reopen();
    expect(f.runner.turns).toHaveLength(0);
    expect(
      f.harness.store.listEntries(roomId, { limit: 20 }).filter((e) => e.authorId === authorId)
    ).toHaveLength(1);
    expect(f.db.select().from(m.db.sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
  it('actual public writer rolls entry back on source owner CAS loss without stealing successor ownership', async () => {
    let id = '';
    script = async (request, ctx) => {
      const owner = ctx.harness.service.handoffs.runningFor(roomId, authorId);
      if (!owner) throw new Error('Missing running source');
      id = owner.id;
      ctx.db
        .update(m.db.roomHandoffOutbox)
        .set({ bootOwner: 'independent-successor' })
        .where(m.db.eq(m.db.roomHandoffOutbox.id, id))
        .run();
      await publish(request, ctx);
    };
    await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Draft' },
      { identity: identity(), sessionId: 'caller', mcpServer: 'in-session' }
    );
    await f.harness.service.handoffs.idle();
    expect(id).not.toBe('');
    expect(
      f.harness.store.listEntries(roomId, { limit: 20 }).filter((e) => e.authorId === authorId)
    ).toHaveLength(0);
    expect(f.harness.store.handoffOutbox.readOwned(id, authorId)).toMatchObject({
      state: 'running',
      bootOwner: 'independent-successor',
      postedEntryId: null,
      noticeState: 'none',
    });
  });
  it('real true-seat replacement invalidates original queued conversation without native alias fiction', async () => {
    const id = await admitThenStop();
    const old = f.harness.store.getRoomSession(roomId, authorId)!;
    f.harness.store.sessionLedger.recordSeatMove(old, roomId, authorId);
    f.harness.store.rebindRoomSession(roomId, authorId, 'independent-fresh-seat');
    await reopen();
    expect(f.runner.turns).toHaveLength(0);
    expect(f.harness.service.handoffs.status(id, authorId)).toMatchObject({ status: 'declined' });
  });
  it('queued source epoch mismatch refuses work and durably skips notice without retargeting', async () => {
    const id = await admitThenStop();
    f.db
      .update(m.db.sessionMetadata)
      .set({ createdAt: '2026-11-16T12:01:00.000Z' })
      .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
      .run();
    await reopen();
    expect(f.runner.turns).toHaveLength(0);
    expect(f.harness.store.handoffOutbox.readOwned(id, authorId)).toMatchObject({
      state: 'declined',
      noticeState: 'skipped',
    });
    expect(f.db.select().from(m.db.sessionMessageQueue).all()).toHaveLength(0);
  });

  it('keeps a settled status private and durable after 501 other-author outcomes and actual database reopen', async () => {
    const { recordFixturePublicSource } = await import('./durable-handoff-fixture.js');
    const otherPath = join(home, 'river');
    mkdirSync(otherPath);
    f.db
      .insert(m.db.agents)
      .values({
        id: 'river-agent',
        name: 'river',
        runtime: 'claude-code',
        projectPath: otherPath,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    // Retain the existing real database/room, with two positively registered fixture actors.
    f.harness.service.dispose();
    await f.harness.service.handoffs.idle();
    await f.harness.service.triggersIdle();
    const contextFor = (path: string, sessionId: string) => ({
      identity: {
        agentPath: path,
        displayName: path === agentPath ? 'Casey' : 'River',
        createdAt: new Date().toISOString(),
      },
      sessionId,
      mcpServer: 'in-session' as const,
    });
    const composeBoth = (db: Db): CompositionContext => {
      m.registry.runtimeRegistry.setDb(db);
      const runner: CompositionContext['runner'] = {
        turns: [],
        requests: [],
        interrupted: [],
        ...m.harness.roomVoice(),
        interrupt: async () => m.testing.mockInterruptReceipt('not-running'),
        async run(request) {
          const sessionId = request.sessionId!;
          request.onSessionBound(sessionId);
          runner.requests.push(request);
          runner.turns.push({
            roomId: request.room.id,
            authorId: request.authorId,
            agentPath: request.agentPath,
            cwd: request.cwd,
            sessionId,
            prompt: request.prompt,
            roomContext: request.roomContext,
            attachmentProjection: request.attachmentProjection,
          });
          if (request.agentPath === agentPath) {
            await registry.invoke(
              'rooms.read_history',
              { roomId: request.room.id },
              contextFor(request.agentPath, sessionId)
            );
            await registry.invoke(
              'rooms.post',
              { roomId: request.room.id, text: 'Stable retained answer', confirm: true },
              contextFor(request.agentPath, sessionId)
            );
            return { sessionId, text: 'Shared the requested update.' };
          }
          // A real admitted turn may decline; this avoids 501 irrelevant public posts.
          return { sessionId, text: 'No room update is needed.' };
        },
      };
      const harness = m.harness.createRoomHarness({
        db,
        agents: m.harness.agentLookupFor({
          [agentPath]: {
            id: 'casey-agent',
            name: 'casey',
            displayName: 'Casey',
            responseMode: 'mention-only',
          },
          [otherPath]: {
            id: 'river-agent',
            name: 'river',
            displayName: 'River',
            responseMode: 'mention-only',
          },
        }),
        runner,
        operatorName: () => 'Owner',
      });
      services.push(harness.service);
      const registry = m.cap.composeRegistry([m.domain.roomsDomain], {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        roomDeps: { rooms: harness.service },
      });
      const source = new m.source.HandoffTerminalSource(db, harness.store.handoffOutbox);
      const acceptance = new m.acceptance.PrivateSessionMessageAcceptanceService(
        db,
        new m.queue.MessageQueueStore(db),
        [source],
        'retention-boot'
      );
      const nudged: string[] = [];
      const notices = new m.notices.HandoffTerminalNotices(
        harness.store.handoffOutbox,
        source,
        acceptance,
        (id) => {
          nudged.push(id);
        }
      );
      const ctx = { db, harness, registry, runner, source, acceptance, notices, nudged };
      harness.service.handoffs.initializeDurable(() => notices.flush());
      return ctx;
    };
    f = composeBoth(f.db);
    f.harness.service.addMember(roomId, f.harness.human, {
      agentPath: otherPath,
      responseMode: 'mention-only',
    });
    const otherAuthor = f.harness.authors.resolveAgent(otherPath, 'River').id;
    expect(otherAuthor).not.toBe(authorId);
    expect(f.harness.store.getMember(roomId, otherAuthor)).not.toBeNull();
    const member = f.harness.store.getMember(roomId, authorId)!;
    await recordFixturePublicSource(f.harness, 'caller', agentPath, roomId);
    // This case proves marked words survive history eviction; the fixture starts clean.
    m.levels.noteRoomTurnWords('caller', true);
    const original = (await f.registry.invoke(
      'rooms.post',
      { roomId, text: 'Keep the original handoff status' },
      contextFor(agentPath, 'caller')
    )) as { handedOff: boolean; handoffId: string };
    expect(original.handedOff).toBe(true);
    expect(original.handoffId).toEqual(expect.any(String));
    await f.harness.service.handoffs.idle();
    const readStatus = (id: string, path = agentPath, session = 'caller') =>
      f.registry.invoke('rooms.handoff_status', { handoffId: id }, contextFor(path, session));
    const originalStatus = await readStatus(original.handoffId);
    expect(originalStatus).toMatchObject({ status: 'posted', entryId: expect.any(String) });
    const saved = f.harness.store.handoffOutbox.readOwned(original.handoffId, authorId)!;
    expect(saved).toMatchObject({
      state: 'posted',
      noticeState: 'accepted',
      noticeReceiptId: expect.any(String),
    });
    const scope = JSON.parse(saved.envelopeJson);
    const caller = f.db
      .select()
      .from(m.db.sessionMetadata)
      .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
      .get()!;
    expect(scope.recipient.createdAt).toBe(caller.createdAt);
    expect(scope.seat.joinedAt).toBe(member.joinedAt);
    expect(scope.carry.outsideWords).toBe(true);
    expect(f.runner.requests[0]).toMatchObject({
      agentPath,
      untrustedText: true,
      outsideWords: true,
    });
    await recordFixturePublicSource(f.harness, 'river-caller', otherPath, roomId);
    const unknownToOther = await readStatus('unallocated-handoff-id', otherPath, 'river-caller');
    expect(unknownToOther).toMatchObject({ status: 'unknown' });
    expect(await readStatus(original.handoffId, otherPath, 'river-caller')).toEqual(unknownToOther);
    const otherIds = new Set<string>();
    for (let index = 0; index < 501; index += 1) {
      const result = (await f.registry.invoke(
        'rooms.post',
        { roomId, text: `Unneeded room update ${index}` },
        contextFor(otherPath, 'river-caller')
      )) as { handedOff: boolean; handoffId: string };
      expect(result.handedOff).toBe(true);
      expect(result.handoffId).toEqual(expect.any(String));
      otherIds.add(result.handoffId);
      await f.harness.service.handoffs.idle();
      expect(await readStatus(result.handoffId, otherPath, 'river-caller')).toMatchObject({
        status: 'declined',
      });
    }
    expect(otherIds.size).toBe(501);
    expect(f.runner.requests.filter((request) => request.agentPath === otherPath)).toHaveLength(
      501
    );
    expect(await readStatus(original.handoffId)).toEqual(originalStatus);
    expect(await readStatus(original.handoffId, otherPath, 'river-caller')).toEqual(unknownToOther);
    const otherRows = f.db
      .select()
      .from(m.db.roomHandoffOutbox)
      .where(m.db.eq(m.db.roomHandoffOutbox.authorId, otherAuthor))
      .all();
    expect(otherRows).toHaveLength(501);
    expect(otherRows.every((row) => row.state === 'declined')).toBe(true);
    expect(
      f.harness.store.handoffOutbox.readOwned(original.handoffId, authorId)?.envelopeJson
    ).toBe(saved.envelopeJson);
    const noticeIds = () =>
      f.db
        .select({ id: m.db.sessionMessageAcceptanceReceipts.id })
        .from(m.db.sessionMessageAcceptanceReceipts)
        .where(m.db.eq(m.db.sessionMessageAcceptanceReceipts.sourceKind, 'room_handoff_terminal'))
        .all()
        .map((row) => row.id)
        .sort();
    const acceptedBefore = noticeIds();
    expect(acceptedBefore).toHaveLength(502);
    f.harness.service.dispose();
    await f.harness.service.handoffs.idle();
    await f.harness.service.triggersIdle();
    f.db.$client.close();
    const reopened = m.db.createDb(file);
    handles.push(reopened);
    m.db.runMigrations(reopened);
    f = composeBoth(reopened);
    await f.harness.service.handoffs.idle();
    f.harness.service.handoffs.flushTerminals();
    f.harness.service.handoffs.flushTerminals();
    expect(await readStatus(original.handoffId)).toEqual(originalStatus);
    expect(await readStatus(original.handoffId, otherPath, 'river-caller')).toEqual(unknownToOther);
    expect(f.harness.store.handoffOutbox.readOwned(original.handoffId, authorId)).toMatchObject({
      state: 'posted',
      envelopeJson: saved.envelopeJson,
      postedEntryId: saved.postedEntryId,
      postedSeq: saved.postedSeq,
      noticeReceiptId: saved.noticeReceiptId,
    });
    expect(f.harness.store.getMember(roomId, authorId)?.joinedAt).toBe(member.joinedAt);
    expect(
      f.db
        .select()
        .from(m.db.sessionMetadata)
        .where(m.db.eq(m.db.sessionMetadata.sessionId, 'caller'))
        .get()?.createdAt
    ).toBe(caller.createdAt);
    expect(
      f.harness.store
        .listEntries(roomId, { limit: 20 })
        .filter((entry) => entry.authorId === authorId)
    ).toHaveLength(1);
    expect(noticeIds()).toEqual(acceptedBefore);
    expect(f.runner.requests).toHaveLength(0);
  }, 30_000);
});
