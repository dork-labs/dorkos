/** Real registry/SQLite/SessionStore and SDK mapper; no model or provider effects. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfigManager } from '../../../core/config-manager.js';
import { initBoundary } from '../../../../lib/boundary.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../../session/fleet/session-limit-store.js';
import { HeartbeatStore } from '../../../heartbeats/heartbeat-store.js';
import {
  getOrCreateProjector,
  peekProjector,
  rekeyProjector,
  disposeProjector,
  type RawSessionEvent,
} from '../../../session/session-state-projector.js';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  eq,
  sql,
  roomSeatLaunchRequirements,
  sessionMetadata,
  sessionNativeBindings,
  sessionStartedBy,
  sessionContext,
  sessionTouches,
  sessionLimits,
  heartbeatBeats,
  roomSessions,
  roomSessionRetirements,
} from '@dorkos/db';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { RequiredSessionIdentityError } from '../../../../lib/replay/required-session-identity-error.js';
import { RuntimeRegistry, runtimeRegistry } from '../../../core/runtime-registry.js';
import { SessionStore } from '../sessions/session-store.js';
import { TranscriptReader } from '../sessions/transcript-reader.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import type { ToolState } from '../agent-types.js';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../../session/origin/session-started-by-store.js';
import {
  SessionTouchStore,
  setSessionTouchStore,
} from '../../../session/origin/session-touch-store.js';
import type { SessionLockManager } from '../../../session/session-lock.js';
import { RoomStore } from '../../../rooms/room-store.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { claudeTranscriptPath } from '../../../session/fleet/carry-over-summary.js';
import { TaskStore } from '../../../tasks/task-store.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw new Error('SDK forbidden in identity-only oracle');
  }),
}));
let registeredRuntime: ClaudeCodeRuntime | undefined;
const source = '4328-required-original';
const target = '4328-independent-target';
let scratch: string;
let root: string;
let home: string;
beforeEach(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), '4328-native-owner-'));
  root = path.join(scratch, 'account');
  home = path.join(scratch, 'agent');
  mkdirSync(root);
  mkdirSync(home);
  const dork = path.join(scratch, 'dork');
  mkdirSync(dork);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    vi.stubEnv(key, '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network forbidden');
    })
  );
  const config = initConfigManager(dork);
  config.setDot('runtimes.claudeCode.accounts', [
    { id: 'actual-account', label: 'Fixture', path: root },
  ]);
  config.setDot('runtimes.claudeCode.defaultAccount', 'actual-account');
  await initBoundary(scratch);
});
afterEach(async () => {
  await registeredRuntime?.endSessionsWhere(() => true);
  registeredRuntime = undefined;
  setSessionStartedByStore(undefined);
  setSessionTouchStore(undefined);
  setSessionLimitStore(undefined);
  disposeProjector(source);
  disposeProjector(target);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(scratch, { recursive: true, force: true });
});
function fixture(occupied = true) {
  const db = createTestDb();
  const registry = new RuntimeRegistry();
  registry.setDb(db);
  db.insert(roomSeatLaunchRequirements)
    .values({
      id: 'required',
      destinationSessionId: source,
      sourceSessionId: 'prior-failed',
      sourceDispatchId: 'prior-dispatch',
      startSeq: 1,
      endSeq: 4,
      payload: JSON.stringify({
        version: 1,
        roomId: 'room',
        authorId: 'author',
        runtime: 'claude-code',
        root,
        accountId: 'actual-account',
        inference: 'own-account',
        billing: 'subscription',
      }),
      state: 'settled',
      createdAt: 'now',
    })
    .run();
  db.insert(sessionMetadata)
    .values({
      sessionId: source,
      runtime: 'claude-code',
      agentPath: home,
      requiredLaunchId: 'required',
      createdAt: 'now',
    })
    .run();
  db.insert(sessionNativeBindings)
    .values({
      sessionId: source,
      runtime: 'claude-code',
      cwd: home,
      account: root,
      createdAt: 'now',
    })
    .run();
  if (occupied) {
    db.insert(sessionMetadata)
      .values({
        sessionId: target,
        runtime: 'claude-code',
        agentPath: home,
        model: 'independent-model',
        createdAt: 'earlier',
      })
      .run();
    db.insert(sessionNativeBindings)
      .values({
        sessionId: target,
        runtime: 'claude-code',
        cwd: home,
        account: root,
        createdAt: 'earlier',
      })
      .run();
  }
  const started = new SessionStartedByStore(db);
  setSessionStartedByStore(started);
  started.insert({
    sessionId: source,
    kind: 'chat',
    startedBySessionId: 'source-parent',
    reason: null,
    extensionId: null,
    originExtensionId: null,
    createdAt: 'now',
  });
  started.insert({
    sessionId: 'source-child',
    kind: 'chat',
    startedBySessionId: source,
    reason: null,
    extensionId: null,
    originExtensionId: null,
    createdAt: 'now',
  });
  if (occupied)
    started.insert({
      sessionId: target,
      kind: 'chat',
      startedBySessionId: 'independent-parent',
      reason: null,
      extensionId: null,
      originExtensionId: null,
      createdAt: 'earlier',
    });
  const touches = new SessionTouchStore(db);
  setSessionTouchStore(touches);
  touches.recordOpened(source, '2026-11-15T10:00:00.000Z');
  db.insert(sessionContext)
    .values({ sessionId: source, contextTokens: 17, contextMaxTokens: 200000, observedAt: 'now' })
    .run();
  db.insert(sessionLimits)
    .values({
      sessionId: source,
      since: 'now',
      window: 'five_hour',
      scope: 'account',
      accountPath: root,
      plan: JSON.stringify({ mode: 'ask' }),
      state: 'limited',
      updatedAt: 'now',
    })
    .run();
  const beats = new HeartbeatStore(db);
  beats.insertBeat({
    id: 'real-beat',
    agentId: 'fixture-agent',
    startedAt: 'now',
    kind: 'pulse',
    wake: 'timer',
  });
  beats.setBeatChat('real-beat', source);
  const tasks = new TaskStore(db);
  const task = tasks.createTask({
    name: 'Required rebind fixture',
    description: 'test',
    prompt: 'test',
    filePath: '/tmp/4328-required-rebind/SKILL.md',
  });
  const run = tasks.createRun(task.id, 'manual');
  tasks.updateRun(run.id, { sessionId: source });
  const store = new SessionStore();
  store.configureSettings(registry, 'default');
  store.ensureSession(source, { cwd: home, permissionMode: 'plan', hasStarted: true });
  const original = store.findSession(source)!;
  original.accountRoot = root;
  if (occupied)
    store.ensureSession(target, { cwd: home, permissionMode: 'default', hasStarted: true });
  const independent = store.findSession(target);
  if (independent) independent.accountRoot = root;
  const snapshot = () => ({
    metadata: db.select().from(sessionMetadata).all(),
    native: db.select().from(sessionNativeBindings).all(),
    requirements: db.select().from(roomSeatLaunchRequirements).all(),
    roomBindings: db.select().from(roomSessions).all(),
    roomAliases: db.select().from(roomSessionRetirements).all(),
    ancestry: db.select().from(sessionStartedBy).all(),
    context: db.select().from(sessionContext).all(),
    limits: db.select().from(sessionLimits).all(),
    beats: db.select().from(heartbeatBeats).all(),
    touches: db.select().from(sessionTouches).all(),
    run: tasks.getRun(run.id),
  });
  async function mapInit() {
    const tools = {
      toolNameById: new Map(),
      resolvedResultIds: new Set(),
      toolInputReceived: new Set(),
    } as unknown as ToolState;
    for await (const _ of mapSdkMessage(
      {
        type: 'system',
        subtype: 'init',
        session_id: target,
        apiKeySource: 'oauth',
      } as unknown as SDKMessage,
      original,
      source,
      tools
    )) {
      /* actual SDK init mutates original */
    }
  }
  async function announce() {
    await mapInit();
    await store.rebindSdkSession(source, target, source, original);
  }
  return { db, registry, store, original, independent, snapshot, announce, mapInit };
}

it('refuses an independent live target even for the same agent/runtime/account root', async () => {
  const f = fixture();
  const before = f.snapshot();
  const refusal = await f.announce().then(
    () => null,
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  expect(f.store.findSession(target)).toBe(f.independent);
  expect(f.store.getInternalSessionId(target)).toBe(target);
  // Later sends must not reuse the refused original object to resume the target.
  await expect(f.store.ensureForMessage(source, new TranscriptReader(), home)).rejects.toBe(
    refusal
  );
  expect(f.store.findSession(target)).toBe(f.independent);
  expect(await f.store.ensureForMessage(target, new TranscriptReader(), home)).toBe(f.independent);
});

it('rolls back ancestry, context, touch and scheduled aliases on an actual late write refusal', async () => {
  const f = fixture(false);
  const before = f.snapshot();
  f.db.run(
    sql`CREATE TRIGGER refuse_required_alias BEFORE UPDATE ON room_seat_launch_requirements BEGIN SELECT RAISE(ABORT, 'required identity write refused'); END`
  );
  await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.snapshot()).toEqual(before);
  expect(f.store.findSession(target)).toBeUndefined();
});

it('does not lose a direct requirement when its destination metadata marker is missing', async () => {
  const f = fixture(false);
  f.db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, source)).run();
  const before = f.snapshot();
  await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.store.findSession(target)).toBeUndefined();
});

it('classifies early ownership read uncertainty as mandatory rather than optional settings loss', async () => {
  const f = fixture(false);
  const before = f.snapshot();
  const readFault = new Error('database read refused');
  let fired = 0;
  const client = f.db.$client;
  const prepare = client.prepare.bind(client);
  const spy = vi.spyOn(client, 'prepare').mockImplementation(((statement: string) => {
    if (
      fired === 0 &&
      /^select\b/i.test(statement.trim()) &&
      /session_metadata|room_seat_launch_requirements/i.test(statement)
    ) {
      fired++;
      throw readFault;
    }
    return prepare(statement);
  }) as typeof client.prepare);
  let caught: unknown;
  try {
    await f.announce();
  } catch (error) {
    caught = error;
  }
  spy.mockRestore();
  expect(fired).toBe(1);
  expect(caught).toBeInstanceOf(RequiredSessionIdentityError);
  expect((caught as Error).cause).toBe(readFault);
  expect(f.snapshot()).toEqual(before);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.store.findSession(target)).toBeUndefined();
});

it('allows a vacant native destination and retains both immutable aliases', async () => {
  const f = fixture(false);
  const rooms = new RoomStore(f.db);
  rooms.bindRoomSession('room', 'author', source, 'now');
  await f.announce();
  expect(f.store.getInternalSessionId(source)).toBe(target);
  expect(f.registry.requiredLaunches().forSession(source)?.id).toBe('required');
  expect(f.registry.requiredLaunches().forSession(target)?.id).toBe('required');
  rooms.sessionLedger.rebindBySessionId(source, target);
  expect(rooms.getRoomSession('room', 'author')).toBe(target);
  // Already committed immutable aliases are positive ownership proof, not
  // matching same-agent/root metadata. A repeated announcement stays idempotent.
  await f.announce();
  expect(f.store.findSession(source)).toBe(f.original);
  expect(f.store.findSession(target)).toBe(f.original);
  expect(f.registry.requiredLaunches().forSession(target)?.id).toBe('required');
  expect(rooms.getRoomSession('room', 'author')).toBe(target);
  expect(rooms.sessionLedger.successorFor(source)).toBe(target);
});

it('does not restore or quarantine a successor object that acquired the original map key while persistence awaited', async () => {
  const f = fixture(false);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const actual = f.registry.rekeySessionSettings.bind(f.registry);
  f.store.configureSettings(
    {
      getSessionSettings: (id) => f.registry.getSessionSettings(id),
      saveSessionSettings: (id, settings) => f.registry.saveSessionSettings(id, settings),
      rekeySessionSettings: async (from, to) => {
        entered();
        await blocked;
        await actual(from, to);
      },
    },
    'default'
  );
  f.db.run(
    sql`CREATE TRIGGER refuse_required_alias BEFORE UPDATE ON room_seat_launch_requirements BEGIN SELECT RAISE(ABORT, 'required identity write refused'); END`
  );
  const result = f.announce().then(
    () => null,
    (error: unknown) => error
  );
  await pending;
  f.original.lastActivity = 0;
  f.store.checkSessionHealth({ cleanup: vi.fn() } as unknown as SessionLockManager);
  f.store.ensureSession(source, { cwd: home, permissionMode: 'plan', hasStarted: true });
  const successor = f.store.findSession(source)!;
  successor.accountRoot = root;
  expect(successor).not.toBe(f.original);
  release();
  expect(await result).toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.store.findSession(source)).toBe(successor);
  expect(successor.sdkSessionId).toBe(source);
  expect(await f.store.ensureForMessage(source, new TranscriptReader(), home)).toBe(successor);
  expect(f.store.findSession(target)).toBeUndefined();
});

it('refuses metadata-only scanner pre-seeding rather than treating matching fields as alias proof', async () => {
  const f = fixture(false);
  f.db
    .insert(sessionMetadata)
    .values({ sessionId: target, runtime: 'claude-code', agentPath: home, createdAt: 'scanner' })
    .run();
  const before = f.snapshot();
  await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(f.original.sdkSessionId).toBe(source);
});

it('refuses a DB-vacant target independently owned by a live SDK object', async () => {
  const f = fixture(false);
  f.store.ensureSession(target, { cwd: home, permissionMode: 'default', hasStarted: true });
  const independent = f.store.findSession(target)!;
  independent.accountRoot = root;
  const before = f.snapshot();
  await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  expect(f.store.findSession(target)).toBe(independent);
  expect(await f.store.ensureForMessage(target, new TranscriptReader(), home)).toBe(independent);
});

it('refuses an independently live projector/history even when its destination has no durable row', async () => {
  const f = fixture(false);
  runtimeRegistry.setDb(f.db);
  getOrCreateProjector(source, home);
  const independent = getOrCreateProjector(target, home);
  independent.ingest({ type: 'turn_start' });
  independent.ingest({ type: 'text_delta', text: 'Independent work' } as RawSessionEvent);
  const before = f.snapshot();
  let refusal: unknown;
  try {
    rekeyProjector(source, target);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(peekProjector(target)).toBe(independent);
  const snapshot = await independent.buildSnapshot(async () => []);
  expect(snapshot.inProgressTurn).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Independent work' })])
  );
  const abort = new AbortController();
  const iterator = independent.subscribe(snapshot.cursor, abort.signal)[Symbol.asyncIterator]();
  const next = iterator.next();
  independent.ingest({ type: 'text_delta', text: 'Still independent' } as RawSessionEvent);
  expect(await next).toMatchObject({ done: false, value: { text: 'Still independent' } });
  abort.abort();
});

it.each(['absent', 'foreign'] as const)(
  'uses Registry-owned SQLite participants with %s global ancillary stores',
  async (mode) => {
    const f = fixture(false);
    const other = createTestDb();
    other
      .insert(sessionStartedBy)
      .values({
        sessionId: 'foreign-child',
        kind: 'chat',
        startedBySessionId: source,
        createdAt: 'now',
      })
      .run();
    other.insert(sessionTouches).values({ sessionId: source, openedAt: 'foreign' }).run();
    other
      .insert(sessionLimits)
      .values({
        sessionId: source,
        since: 'foreign',
        window: 'five_hour',
        scope: 'account',
        plan: '{}',
        state: 'limited',
        updatedAt: 'foreign',
      })
      .run();
    setSessionStartedByStore(mode === 'foreign' ? new SessionStartedByStore(other) : undefined);
    setSessionTouchStore(mode === 'foreign' ? new SessionTouchStore(other) : undefined);
    setSessionLimitStore(mode === 'foreign' ? new SessionLimitStore(other) : undefined);
    const foreign = () => ({
      ancestry: other.select().from(sessionStartedBy).all(),
      touches: other.select().from(sessionTouches).all(),
      limits: other.select().from(sessionLimits).all(),
    });
    const unrelated = foreign();
    const before = f.snapshot();
    const result = await f.announce().then(
      () => null,
      (error: unknown) => error
    );
    expect(foreign()).toEqual(unrelated);
    if (result) {
      expect(result).toBeInstanceOf(RequiredSessionIdentityError);
      expect(f.snapshot()).toEqual(before);
      expect(f.original.sdkSessionId).toBe(source);
    } else {
      expect(f.db.select().from(sessionLimits).get()?.sessionId).toBe(target);
      expect(f.db.select().from(heartbeatBeats).get()?.turnSessionId).toBe(target);
      expect(
        f.db
          .select()
          .from(sessionStartedBy)
          .where(eq(sessionStartedBy.sessionId, 'source-child'))
          .get()?.startedBySessionId
      ).toBe(target);
      expect(f.db.select().from(sessionTouches).get()?.sessionId).toBe(target);
    }
  }
);

it('retains legacy optional metadata-write failure only for a positively ordinary pair', async () => {
  const f = fixture(false);
  f.db.delete(roomSeatLaunchRequirements).run();
  f.db.update(sessionMetadata).set({ requiredLaunchId: null }).run();
  expect(f.registry.requiredLaunches().forSession(source)).toBeNull();
  expect(f.registry.requiredLaunches().forSession(target)).toBeNull();
  f.db.run(
    sql`CREATE TRIGGER refuse_ordinary_metadata BEFORE DELETE ON session_metadata BEGIN SELECT RAISE(ABORT, 'ordinary settings unavailable'); END`
  );
  await f.mapInit();
  await expect(f.store.rebindSdkSession(source, target, source)).resolves.toBeUndefined();
  expect(f.store.findSession(target)).toBe(f.original);
  expect(f.store.getInternalSessionId(source)).toBe(target);
  expect(
    f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, source)).get()
  ).toBeDefined();
});

it('projector-first refuses a DB/projector-vacant target owned only by the actual registered Claude runtime', async () => {
  const f = fixture(false);
  runtimeRegistry.setDb(f.db);
  registeredRuntime = new ClaudeCodeRuntime(path.join(scratch, 'dork'), home);
  registeredRuntime.setSessionSettings(runtimeRegistry);
  runtimeRegistry.register(registeredRuntime);
  registeredRuntime.ensureSession(source, { cwd: home, permissionMode: 'plan', hasStarted: true });
  registeredRuntime.ensureSession(target, {
    cwd: home,
    permissionMode: 'default',
    hasStarted: true,
  });
  const originalProjector = getOrCreateProjector(source, home);
  expect(peekProjector(target)).toBeUndefined();
  expect(
    f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, target)).get()
  ).toBeUndefined();
  expect(
    f.db
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, target))
      .get()
  ).toBeUndefined();
  const before = f.snapshot();
  let refusal: unknown;
  try {
    rekeyProjector(source, target);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(peekProjector(source)).toBe(originalProjector);
  expect(peekProjector(target)).toBeUndefined();
  expect(registeredRuntime.getInternalSessionId(source)).toBe(source);
  expect(registeredRuntime.getInternalSessionId(target)).toBe(target);
  // Re-ensure uses the same independently owned target; it does not adopt source.
  registeredRuntime.ensureSession(target, {
    cwd: home,
    permissionMode: 'default',
    hasStarted: true,
  });
  expect(registeredRuntime.getInternalSessionId(target)).toBe(target);
  expect(query).not.toHaveBeenCalled();
});

it('keeps the exact refusal and restored old lookup when a quarantined SDK producer announces again', async () => {
  const f = fixture(false);
  f.db.run(
    sql`CREATE TRIGGER refuse_required_alias BEFORE UPDATE ON room_seat_launch_requirements BEGIN SELECT RAISE(ABORT, 'required identity write refused'); END`
  );
  const first = await f.announce().then(
    () => null,
    (error: unknown) => error
  );
  expect(first).toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  const before = f.snapshot();
  await expect(f.announce()).rejects.toBe(first);
  expect(f.original.sdkSessionId).toBe(source);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  expect(f.store.findSession(target)).toBeUndefined();
  expect(f.snapshot()).toEqual(before);
});

it('uses the actual SDK producer when a successor appears between mapper yield and callback entry', async () => {
  const f = fixture(false);
  await f.mapInit();
  f.original.lastActivity = 0;
  f.store.checkSessionHealth({ cleanup: vi.fn() } as unknown as SessionLockManager);
  f.store.ensureSession(source, { cwd: home, permissionMode: 'plan', hasStarted: true });
  const successor = f.store.findSession(source)!;
  successor.accountRoot = root;
  const before = f.snapshot();
  // buildSenderOpts captures this exact producer before the SDK mapper runs.
  await expect(f.store.rebindSdkSession(source, target, source, f.original)).rejects.toBeInstanceOf(
    RequiredSessionIdentityError
  );
  expect(f.snapshot()).toEqual(before);
  expect(f.store.findSession(source)).toBe(successor);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  expect(f.store.findSession(target)).toBeUndefined();
  expect(await f.store.ensureForMessage(source, new TranscriptReader(), home)).toBe(successor);
});

it('refuses a cold retired normal room identity without reviving its alias or disturbing its successor', async () => {
  const f = fixture(false);
  const successor = '4328-normal-room-successor';
  const rooms = new RoomStore(f.db);
  rooms.bindRoomSession('independent-room', 'independent-author', target, 'now');
  f.db
    .insert(sessionMetadata)
    .values({
      sessionId: target,
      runtime: 'claude-code',
      agentPath: home,
      permissionMode: 'plan',
      createdAt: 'earlier',
    })
    .run();
  f.db
    .insert(sessionNativeBindings)
    .values({
      sessionId: target,
      runtime: 'claude-code',
      cwd: home,
      account: root,
      createdAt: 'earlier',
    })
    .run();
  const history = new SessionEventStore(f.db);
  history.appendTurn(target, [
    { type: 'turn_start', seq: 1, userMessage: 'Independent prior work' },
    { type: 'turn_end', seq: 2 },
  ]);
  await f.registry.rekeySessionSettings(target, successor);
  history.rekeySession(target, successor);
  rooms.sessionLedger.rebindBySessionId(target, successor);
  expect(rooms.sessionLedger.successorFor(target)).toBe(successor);
  expect(
    f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, target)).get()
  ).toBeUndefined();
  expect(
    f.db
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, target))
      .get()
  ).toBeUndefined();
  expect(history.readAll(target)).toEqual([]);
  expect(f.store.findSession(target)).toBeUndefined();
  expect(peekProjector(target)).toBeUndefined();
  const native = claudeTranscriptPath(root, home, successor)!;
  mkdirSync(path.dirname(native), { recursive: true });
  const text =
    JSON.stringify({
      type: 'user',
      uuid: 'normal-user',
      sessionId: successor,
      cwd: home,
      message: { role: 'user', content: 'Independent intact history' },
    }) + '\n';
  writeFileSync(native, text);
  const before = f.snapshot();
  const previousHistory = history.readAll(successor);
  await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
  expect(f.snapshot()).toEqual(before);
  expect(f.store.getInternalSessionId(source)).toBe(source);
  expect(rooms.getRoomSession('independent-room', 'independent-author')).toBe(successor);
  expect(rooms.sessionLedger.bindingForSession(target)).toMatchObject({
    roomId: 'independent-room',
    authorId: 'independent-author',
    sessionId: successor,
  });
  expect(rooms.rebindRoomSession('independent-room', 'independent-author', target)).toBe(false);
  expect(rooms.rebindRoomSession('independent-room', 'independent-author', successor)).toBe(true);
  const reopened = await f.store.ensureForMessage(successor, new TranscriptReader(), home);
  expect(reopened.sdkSessionId).toBe(successor);
  expect(reopened.permissionMode).toBe('plan');
  expect(history.readAll(successor)).toEqual(previousHistory);
  expect(readFileSync(native, 'utf8')).toBe(text);
  expect(query).not.toHaveBeenCalled();
});

it.each(['foreign', 'same-tuple'] as const)(
  'refuses a %s binding-only placeholder before its runtime or native rows exist',
  async (variant) => {
    const f = fixture(false);
    const rooms = new RoomStore(f.db);
    rooms.bindRoomSession('room', 'author', source, 'now');
    const targetRoom = variant === 'foreign' ? 'independent-room' : 'room';
    const targetAuthor = variant === 'foreign' ? 'independent-author' : 'author';
    if (variant === 'same-tuple') {
      // The seat moved to a NEW placeholder. Matching room/author does not make
      // that independent placeholder an alias of the old required conversation.
      expect(rooms.rebindRoomSession('room', 'author', target)).toBe(true);
    } else rooms.bindRoomSession(targetRoom, targetAuthor, target, 'now');
    expect(
      f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, target)).get()
    ).toBeUndefined();
    expect(
      f.db
        .select()
        .from(sessionNativeBindings)
        .where(eq(sessionNativeBindings.sessionId, target))
        .get()
    ).toBeUndefined();
    const before = f.snapshot();
    await expect(f.announce()).rejects.toBeInstanceOf(RequiredSessionIdentityError);
    expect(f.snapshot()).toEqual(before);
    expect(f.store.getInternalSessionId(source)).toBe(source);
    expect(rooms.getRoomSession('room', 'author')).toBe(variant === 'foreign' ? source : target);
    expect(rooms.getRoomSession(targetRoom, targetAuthor)).toBe(target);
    expect(rooms.sessionLedger.bindingForSession(target)).toMatchObject({
      roomId: targetRoom,
      authorId: targetAuthor,
      sessionId: target,
    });
    expect(rooms.rebindRoomSession(targetRoom, targetAuthor, target)).toBe(true);
    expect(f.registry.requiredLaunches().forSession(source)?.destinationSessionId).toBe(source);
  }
);
