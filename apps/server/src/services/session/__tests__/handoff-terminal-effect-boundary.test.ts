/** Actual triggerTurn + real protected coordinator/SQLite and real context-warning await. */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerTurnOpts } from '../trigger-turn.js';
import type { Db } from '@dorkos/db';
let db: Db, home: string, agentHome: string, releaseContext: (() => void) | undefined;
let homes: typeof import('../../core/agent-identity/__tests__/agent-home-fixture.js');
let permission: typeof import('../../core/capabilities/permission-enforcement.js');
let projector: typeof import('../session-state-projector.js');
let trigger: typeof import('../trigger-turn.js');
let schema: typeof import('@dorkos/db');
let coordinator: import('../private-messages/acceptance.js').PrivateSessionMessageAcceptanceService;
let adapter: import('../../rooms/handoff/handoff-terminal-source.js').HandoffTerminalSource;
let receiptId: string;
let contextEntered: Promise<void>;
let pending: Promise<unknown> | undefined;
let otherDatabases: Db[] = [];
let projectorSessions: string[] = [];
let staged: typeof import('../staged-context-store.js') | undefined;
const SESSION = '7f5d27ba-4d70-4c93-8b31-1c5520550c72';
const NOW = new Date('2026-11-16T12:00:00.000Z');
beforeEach(async () => {
  staged = undefined;
  otherDatabases = [];
  projectorSessions = [SESSION];
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'handoff-final-effect-'));
  agentHome = join(home, 'casey');
  mkdirSync(agentHome);
  vi.stubEnv('DORK_HOME', home);
  schema = await import('@dorkos/db');
  db = schema.createDb(join(home, 'owned.sqlite'));
  schema.runMigrations(db);
  // The fixture also wires the agent facts port turn code reads homes through.
  homes = await import('../../core/agent-identity/__tests__/agent-home-fixture.js');
  homes.registerTestHomes([agentHome]);
  let entered!: () => void;
  contextEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseContext = resolve;
  });
  permission = await import('../../core/capabilities/permission-enforcement.js');
  // Supported actual permission source is the IO seam awaited by REAL isCompactionBlocked.
  permission.initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => {
      entered();
      await gate;
      return undefined;
    },
  });
  projector = await import('../session-state-projector.js');
  trigger = await import('../trigger-turn.js');
  const { captureAdmissionRecipient } =
    await import('../../rooms/handoff/outbox/admission-recipient.js');
  const { HandoffOutboxStore } = await import('../../rooms/handoff/outbox/handoff-outbox-store.js');
  const { HandoffTerminalSource } = await import('../../rooms/handoff/handoff-terminal-source.js');
  const { MessageQueueStore } = await import('../message-queue-store.js');
  const { PrivateSessionMessageAcceptanceService } =
    await import('../private-messages/acceptance.js');
  db.insert(schema.agents)
    .values({
      id: 'casey-agent',
      name: 'casey',
      runtime: 'claude-code',
      projectPath: agentHome,
      registeredAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  db.insert(schema.authors)
    .values({
      id: 'casey-author',
      kind: 'agent',
      naturalKey: agentHome,
      displayName: 'Casey',
      mintedForManifestId: 'casey-agent',
      createdAt: NOW.toISOString(),
    })
    .run();
  db.insert(schema.sessionMetadata)
    .values({
      sessionId: SESSION,
      runtime: 'claude-code',
      agentPath: agentHome,
      launchOrigin: 'interactive',
      createdAt: NOW.toISOString(),
    })
    .run();
  const recipient = captureAdmissionRecipient(db, SESSION, 'casey-author', agentHome);
  if (!recipient) throw new Error('Real positive admission recipient missing');
  const envelopeJson = JSON.stringify({
    version: 2,
    recipient,
    evidence: {
      state: 'recorded-transfer',
      wordEvidence: 'conservative',
      sessionId: SESSION,
      turnSerial: 1,
    },
    source: { id: 'source', callerSessionId: SESSION, agentPath: agentHome },
    seat: {
      roomId: 'room',
      authorId: 'casey-author',
      sessionId: 'seat',
      canonicalSessionId: 'seat',
      joinedAt: NOW.toISOString(),
      agentPath: agentHome,
    },
    enqueuedAt: 1000,
    waitDeadlineAt: 121000,
    carry: {
      externalAuthor: true,
      outsider: true,
      outsideWords: true,
      teammate: true,
      permissionCeiling: {
        asks: 'never',
        reach: 'everything',
        teammate: [{ roomId: 'room', authorId: 'casey-author' }],
      },
    },
  });
  const outbox = new HandoffOutboxStore(db);
  outbox.admit({
    envelopeJson,
    draft: 'Never dispatch this draft as notice',
    originJson: JSON.stringify({
      sessionId: SESSION,
      roomId: null,
      label: 'another chat',
      requester: null,
      memberJoinedAt: null,
    }),
    verbatim: false,
  });
  outbox.claimQueued('source', envelopeJson, 'boot-a', 1000, () => {});
  outbox.declineOwned('source', 'boot-a', 'No post.');
  adapter = new HandoffTerminalSource(db, outbox);
  coordinator = new PrivateSessionMessageAcceptanceService(
    db,
    new MessageQueueStore(db),
    [adapter],
    'boot-a',
    () => NOW
  );
  receiptId = coordinator.accept(adapter.reference('source')).receipt.id;
  const warning = await import('../agent-compaction/context-warning.js');
  warning.noteContextReading(SESSION, { totalTokens: 950, maxTokens: 1000 });
});
afterEach(async () => {
  releaseContext?.();
  try {
    await pending;
  } finally {
    staged?.setStagedContextStore(undefined);
    staged?.resetStagedContextStore();
    for (const id of projectorSessions) projector?.disposeProjector(id);
    homes?.clearTestHomes();
    permission?.resetPermissionGate();
    vi.resetModules();
    for (const other of otherDatabases) other.$client.close();
    db?.$client.close();
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
    pending = undefined;
    releaseContext = undefined;
  }
});
async function start(extra: Partial<TriggerTurnOpts> = {}) {
  const { FakeAgentRuntime } = await import('@dorkos/test-utils');
  const runtime = new FakeAgentRuntime('claude-code');
  let settled!: () => void;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const operation = trigger.triggerTurn({
    sessionId: SESSION,
    clientId: 'system:room_handoff_terminal',
    content: '[Room handoff update]',
    cwd: agentHome,
    forAgent: agentHome,
    privateReceiptId: receiptId,
    permissionCeiling: { asks: 'always', reach: 'read' },
    projector: projector.getOrCreateProjector(SESSION, agentHome),
    onSettled: settled,
    ...extra,
    deps: {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: runtime.sendMessage.bind(runtime),
      interruptQuery: runtime.interruptQuery.bind(runtime),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: runtime.getCapabilities.bind(runtime),
      preparePrivateMessage: (id) => coordinator.prepare(id),
      claimPrivateMessage: (id, prepared, sessionId) =>
        coordinator.claim(
          id,
          prepared,
          sessionId ? { sessionId, runtime: runtime.type } : undefined
        ),
      isPrivatePreclaimRefusal: (id, error) => coordinator.isPreclaimRefusal(id, error),
      cancelPrivateMessage: (id, reason) => coordinator.cancel(id, reason),
      markPrivateOutcomeUnknown: (id, reason) => coordinator.markOutcomeUnknown(id, reason),
    },
  });
  // Observe rejection immediately while the actual context IO is still held.
  const observed = operation.then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  pending = observed.then(async (outcome) => {
    if ('result' in outcome && outcome.result.accepted) await done;
    return outcome;
  });
  await contextEntered;
  return { runtime, observed, done };
}
async function stageOriginal(session = SESSION, database = db) {
  staged = await import('../staged-context-store.js');
  staged.setStagedContextStore(new staged.StagedContextStore(database));
  staged.holdStagedContext(session, 'One original staged note', 'original-staged-message');
}
async function ordinaryRetry(session = SESSION) {
  const { FakeAgentRuntime } = await import('@dorkos/test-utils');
  const runtime = new FakeAgentRuntime('claude-code');
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const operation = trigger.triggerTurn({
    sessionId: session,
    clientId: 'ordinary-retry',
    content: 'Continue ordinary work',
    cwd: agentHome,
    forAgent: agentHome,
    projector: projector.getOrCreateProjector(session, agentHome),
    onSettled: finished,
    deps: {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: runtime.sendMessage.bind(runtime),
      interruptQuery: runtime.interruptQuery.bind(runtime),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: runtime.getCapabilities.bind(runtime),
    },
  });
  pending = operation.then(async (result) => {
    if (result.accepted) await done;
    return result;
  });
  expect((await operation).accepted).toBe(true);
  await done;
  const notes = runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext?.filter(
    (note) => note.kind === 'staged_context'
  );
  expect(notes).toHaveLength(1);
  expect(notes?.[0]).toMatchObject({ data: { text: 'One original staged note' } });
  expect(staged?.takeStagedContext(session)).toEqual([]);
}
const roomFact = { roomId: 'room', authorId: 'casey-author', turnId: 'server-owned-cleanup-test' };
describe('protected terminal notice actual final runtime boundary', () => {
  it('defuses the final rich private notice through real coordinator and trigger before Claude command/file interpretation', async () => {
    const displayName = '/fixture-command @/name-fixture.txt';
    const reason = 'Could not post @/reason-fixture.txt';
    db.update(schema.authors)
      .set({ displayName })
      .where(schema.eq(schema.authors.id, 'casey-author'))
      .run();
    const author = db
      .select()
      .from(schema.authors)
      .where(schema.eq(schema.authors.id, 'casey-author'))
      .get()!;
    const { buildHandoffNotice } = await import('../../rooms/notices/notice-copy.js');
    const rich = buildHandoffNotice(author.displayName!, 'casey-author', '#destination', reason);
    expect(rich.text).toContain('@/name-fixture.txt');
    expect(rich.text).toContain('@/reason-fixture.txt');
    db.update(schema.roomHandoffOutbox)
      .set({ noticeText: rich.text!, terminalReason: reason })
      .where(schema.eq(schema.roomHandoffOutbox.id, 'source'))
      .run();
    const prepared = await coordinator.prepare(receiptId);
    expect(prepared.content).toBe(rich.text);
    const { runtime, observed, done } = await start();
    releaseContext!();
    expect(await observed).toMatchObject({ result: { accepted: true } });
    await done;
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const [, content, opts] = runtime.sendMessage.mock.calls[0]!;
    expect(content).toBe(`[Room handoff update]\n${rich.text!.replaceAll('@', '\u200b@')}`);
    expect(content).toContain('\u200b@/name-fixture.txt');
    expect(content).toContain('\u200b@/reason-fixture.txt');
    expect(opts?.roomTurn).toBeUndefined(); // No invented room routing just to obtain an untrusted flag.
    expect(opts?.carriedMarks?.outsider).toBe(true);
    expect(opts?.unattendedApprovals).toBe(true);
    // Actual Claude edge functions, with the same NO-room flag passed by this real trigger.
    // No native CLI or SDK launch is needed to prove this final interpretation boundary.
    const { detectSlashCommandName } =
      await import('../../runtimes/claude-code/messaging/message-sender-shared.js');
    const { enrichContent } = await import('../../runtimes/claude-code/enrich-content.js');
    expect(detectSlashCommandName(rich.text!)).toBe('fixture-command'); // Discriminating unsafe control.
    expect(detectSlashCommandName(content)).toBeNull();
    const actualEnriched = enrichContent(content, opts?.additionalContext, false);
    expect(actualEnriched).not.toMatch(/(?<!\u200b)@\//u);
    expect(actualEnriched).toContain('\u200b@/reason-fixture.txt');
    expect(
      db
        .select()
        .from(schema.roomHandoffOutbox)
        .where(schema.eq(schema.roomHandoffOutbox.id, 'source'))
        .get()
    ).toMatchObject({ noticeText: rich.text, terminalReason: reason });
    expect(prepared.content).toBe(rich.text);
  });
  it.each(['retarget', 'deactivate'] as const)(
    'refuses %s during real context-warning await before ANY runtime call',
    async (change) => {
      await stageOriginal();
      const { runtime, observed } = await start({ roomTurn: roomFact });
      const during = db
        .select()
        .from(schema.sessionMessageAcceptanceReceipts)
        .where(schema.eq(schema.sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (change === 'retarget')
        db.update(schema.sessionMetadata)
          .set({ agentPath: join(home, 'other') })
          .where(schema.eq(schema.sessionMetadata.sessionId, SESSION))
          .run();
      else
        db.update(schema.agents)
          .set({ status: 'inactive' })
          .where(schema.eq(schema.agents.id, 'casey-agent'))
          .run();
      releaseContext!();
      const result = await observed;
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect('error' in result).toBe(true);
      expect(during?.state).toBe('accepted');
      expect(during?.dispatchAttemptId).toBeNull();
      const final = db
        .select()
        .from(schema.sessionMessageAcceptanceReceipts)
        .where(schema.eq(schema.sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      expect(final).toMatchObject({
        state: 'cancelled',
        dispatchAttemptId: null,
        cancellationCode: 'authority_changed_before_dispatch',
      });
      const { uiTurnFacts } = await import('../browser-seat/ui-turn-facts.js');
      expect(uiTurnFacts.read(SESSION).roomTurn).toBeUndefined();
      // Restore real current authority before a person's ordinary retry; this is not receipt replay.
      db.update(schema.sessionMetadata)
        .set({ agentPath: agentHome })
        .where(schema.eq(schema.sessionMetadata.sessionId, SESSION))
        .run();
      db.update(schema.agents)
        .set({ status: 'active' })
        .where(schema.eq(schema.agents.id, 'casey-agent'))
        .run();
      await ordinaryRetry();
    }
  );
  it('sends once for unchanged recipient, retaining real current cap, original marks and D4 behavior', async () => {
    const { runtime, observed, done } = await start();
    releaseContext!();
    const result = await observed;
    expect('result' in result && result.result.accepted).toBe(true);
    await done;
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const opts = runtime.sendMessage.mock.calls[0]?.[2];
    expect(opts?.permissionCeiling).toEqual(
      expect.arrayContaining([
        { asks: 'always', reach: 'read' },
        {
          asks: 'never',
          reach: 'everything',
          teammate: [{ roomId: 'room', authorId: 'casey-author' }],
        },
      ])
    );
    expect(opts?.carriedMarks?.outsider).toBe(true);
    expect(opts?.unattendedApprovals).toBe(true);
    const levels = await import('../../core/turn-power/outside-words.js');
    expect(levels.roomTurnReadOutsideWords(SESSION)).toBe(true);
  });
  it('late protected abort clears bound UI facts and restores staged context once without claiming', async () => {
    await stageOriginal();
    const abort = new AbortController();
    const { runtime, observed } = await start({
      privateDispatchSignal: abort.signal,
      roomTurn: roomFact,
    });
    abort.abort();
    releaseContext!();
    const result = await observed;
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: { accepted: false, suspended: true } });
    const { uiTurnFacts } = await import('../browser-seat/ui-turn-facts.js');
    expect(uiTurnFacts.read(SESSION).roomTurn).toBeUndefined();
    expect(
      db
        .select()
        .from(schema.sessionMessageAcceptanceReceipts)
        .where(schema.eq(schema.sessionMessageAcceptanceReceipts.id, receiptId))
        .get()
    ).toMatchObject({ state: 'accepted', dispatchAttemptId: null });
    await ordinaryRetry();
  });
  it('genuine document budget deferral clears UI facts and restores staged context exactly once', async () => {
    releaseContext!();
    const { batchFixture } = await import('../../canvas/doc-channel/__tests__/batch-fixtures.js');
    // Real existing grant/batch source and real route budget; no hand-written deferral callback.
    const f = batchFixture(
      join(home, 'document-budget.sqlite'),
      null,
      undefined,
      'doc-boot',
      'claude-code',
      undefined,
      undefined,
      { turnsPerHour: 1 }
    );
    otherDatabases.push(f.db);
    f.input();
    const previous = f.admission.admit(f.batchId());
    f.admission.acceptance.claim(
      previous.receipt.id,
      await f.admission.acceptance.prepare(previous.receipt.id)
    );
    f.admission.acceptance.markTurnStarted(previous.receipt.id, 42);
    f.admission.acceptance.settle(previous.receipt.id, 'ok');
    f.input({ checked: false });
    const next = f.admission.admit(f.batchId());
    const session = next.receipt.sessionId;
    projectorSessions.push(session);
    await stageOriginal(session, f.db);
    const { FakeAgentRuntime } = await import('@dorkos/test-utils');
    const runtime = new FakeAgentRuntime('claude-code');
    const result = await trigger.triggerTurn({
      sessionId: session,
      clientId: 'system:document_event_batch',
      content: '[Document update]',
      cwd: agentHome,
      forAgent: agentHome,
      privateReceiptId: next.receipt.id,
      roomTurn: roomFact,
      projector: projector.getOrCreateProjector(session, agentHome),
      deps: {
        acquireLock: () => true,
        releaseLock: () => {},
        sendMessage: runtime.sendMessage.bind(runtime),
        interruptQuery: runtime.interruptQuery.bind(runtime),
        getInternalSessionId: () => undefined,
        rekeyProjector: () => {},
        getCapabilities: runtime.getCapabilities.bind(runtime),
        preparePrivateMessage: (id) => f.admission.acceptance.prepare(id),
        claimPrivateMessage: (id, prepared, sessionId) =>
          f.admission.acceptance.claim(
            id,
            prepared,
            sessionId ? { sessionId, runtime: runtime.type } : undefined
          ),
      },
    });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ accepted: false, deferred: { reason: 'route_turn_ceiling' } });
    const { uiTurnFacts } = await import('../browser-seat/ui-turn-facts.js');
    expect(uiTurnFacts.read(session).roomTurn).toBeUndefined();
    expect(
      f.db
        .select()
        .from(schema.sessionMessageAcceptanceReceipts)
        .where(schema.eq(schema.sessionMessageAcceptanceReceipts.id, next.receipt.id))
        .get()
    ).toMatchObject({ state: 'accepted', dispatchAttemptId: null });
    await ordinaryRetry(session);
  });
  it('does not requeue staged notes after the actual runtime invocation throws', async () => {
    releaseContext!();
    await stageOriginal();
    const { FakeAgentRuntime } = await import('@dorkos/test-utils');
    const runtime = new FakeAgentRuntime('claude-code');
    const exact = new Error('External runtime invocation failed');
    runtime.sendMessage.mockImplementationOnce(() => {
      throw exact;
    });
    let caught: unknown;
    try {
      await trigger.triggerTurn({
        sessionId: SESSION,
        clientId: 'ordinary-attempted',
        content: 'Try once',
        cwd: agentHome,
        forAgent: agentHome,
        roomTurn: roomFact,
        projector: projector.getOrCreateProjector(SESSION, agentHome),
        deps: {
          acquireLock: () => true,
          releaseLock: () => {},
          sendMessage: runtime.sendMessage.bind(runtime),
          interruptQuery: runtime.interruptQuery.bind(runtime),
          getInternalSessionId: () => undefined,
          rekeyProjector: () => {},
          getCapabilities: runtime.getCapabilities.bind(runtime),
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(exact);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(staged?.takeStagedContext(SESSION)).toEqual([]);
    const { uiTurnFacts } = await import('../browser-seat/ui-turn-facts.js');
    expect(uiTurnFacts.read(SESSION).roomTurn).toBeUndefined();
  });
  it('ordinary held dispatch restores one staged note exactly once for the actual next turn', async () => {
    releaseContext!();
    staged = await import('../staged-context-store.js');
    staged.setStagedContextStore(new staged.StagedContextStore(db));
    staged.holdStagedContext(SESSION, 'One original staged note', 'original-staged-message');
    const { FakeAgentRuntime } = await import('@dorkos/test-utils');
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.holdDispatch.mockReturnValueOnce({
      reason: 'background-work',
      holding: { agents: 0, shells: 1, other: 0 },
      pins: ['cwd'],
      since: NOW.getTime(),
      releaseAt: NOW.getTime() + 120000,
    });
    const deps = {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: runtime.sendMessage.bind(runtime),
      interruptQuery: runtime.interruptQuery.bind(runtime),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: runtime.getCapabilities.bind(runtime),
      answersDispatchHold: true,
    };
    const ordinary = {
      sessionId: SESSION,
      clientId: 'ordinary-window',
      content: 'Continue ordinary work',
      cwd: agentHome,
      forAgent: agentHome,
      projector: projector.getOrCreateProjector(SESSION, agentHome),
      deps,
    };
    const first = await trigger.triggerTurn(ordinary);
    expect(first.accepted).toBe(false);
    expect('held' in first).toBe(true);
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const second = trigger.triggerTurn({ ...ordinary, onSettled: finished });
    pending = second.then(async (result) => {
      if (result.accepted) await done;
      return result;
    });
    expect((await second).accepted).toBe(true);
    await done;
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    const notes = runtime.sendMessage.mock.calls[1]?.[2]?.additionalContext?.filter(
      (note) => note.kind === 'staged_context'
    );
    expect(notes).toHaveLength(1);
    expect(notes?.[0]).toMatchObject({ data: { text: 'One original staged note' } });
    expect(staged.takeStagedContext(SESSION)).toEqual([]);
  });
});
