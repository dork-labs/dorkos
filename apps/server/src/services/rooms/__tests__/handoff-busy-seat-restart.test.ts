/**
 * A hand-off restored after a restart is never posted for its room chat at boot (DOR-4252): what
 * its drafting chat had read is gone with the old process, so it waits for the room chat, which
 * re-reads the room and decides. Real migrations on a file database, reopened as a restart does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { noteSeen, resetFreshnessForTests } from '../messages/room-freshness.js';
import {
  agentLookupFor,
  createRoomHarness,
  roomVoice,
  type ScriptedTurnRunner,
} from './room-test-harness.js';
import { recordFixturePublicSource } from './durable-handoff-fixture.js';

const agents = agentLookupFor({
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});
const handles: Db[] = [];
let home: string | undefined;
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  vi.useRealTimers();
  resetPermissionGate();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

it('after a restart, a queued hand-off past its two minutes goes to the free room chat, not posted at boot', async () => {
  home = mkdtempSync(join(tmpdir(), 'probe-4252-boot-'));
  vi.stubEnv('DORK_HOME', home);
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-25T09:00:00.000Z'));
  resetFreshnessForTests();
  const file = join(home, 'rooms.sqlite');
  let releaseLong!: () => void;
  const longTurn = new Promise<void>((r) => (releaseLong = r));
  const handoffTurns: string[] = [];
  const runnerFor = (hold: boolean): ScriptedTurnRunner => ({
    turns: [],
    interrupted: [],
    ...roomVoice(),
    interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
    async run(request) {
      const sessionId = request.sessionId ?? 'bo-seat';
      request.onSessionBound(sessionId);
      if (request.prompt.includes('BEGIN HANDED-OFF DRAFT')) handoffTurns.push(request.prompt);
      else if (hold) await longTurn;
      return { sessionId, text: null };
    },
  });
  const open = (hold: boolean) => {
    const db = createDb(file);
    handles.push(db);
    runMigrations(db);
    runtimeRegistry.setDb(db);
    return createRoomHarness({ db, agents, runner: runnerFor(hold) });
  };
  const first = open(true);
  first.service.handoffs.initializeDurable(() => {});
  const room = first.service.createRoom(
    { kind: 'channel', title: 'launch', members: [], agentPaths: ['/agents/bo'] },
    first.human
  );
  const bo = first.authors.resolveAgent('/agents/bo', 'Bo');
  first.store.bindRoomSession(room.id, bo.id, 'bo-seat', new Date().toISOString());
  first.service.post(room.id, { authorId: first.human, text: '@bo please run the long job' });
  for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(0);
  await recordFixturePublicSource(first, 'bo-direct-chat', '/agents/bo', room.id);
  // The drafting chat had read the room, so before the restart it was a stand-in's to post.
  const [newest] = first.store.listEntries(room.id, { limit: 1 });
  noteSeen(room.id, bo.id, newest!.seq, 'bo-direct-chat');
  const receipt = await first.service.handoffs.handOff({
    roomId: room.id,
    author: bo,
    text: 'Posted at boot without a seat turn.',
    verbatim: false,
    callerSessionId: 'bo-direct-chat',
  });
  const id = receipt.handoffId as string;
  expect(id).toEqual(expect.any(String));
  await vi.advanceTimersByTimeAsync(60_000);
  first.service.handoffs.stop();
  expect(first.store.handoffOutbox.readOwned(id, bo.id)?.state).toBe('queued');

  await vi.advanceTimersByTimeAsync(90_000);
  const second = open(false);
  const bo2 = second.authors.resolveAgent('/agents/bo', 'Bo');
  second.service.handoffs.initializeDurable(() => {});
  await second.service.handoffs.idle();
  const posts = second.store
    .listEntries(room.id, { limit: 50 })
    .filter((e) => e.kind === 'post' && e.authorId === bo2.id);
  expect(posts).toHaveLength(0);
  expect(handoffTurns).toHaveLength(1);
  expect(second.store.handoffOutbox.readOwned(id, bo2.id)?.state).not.toBe('posted');
  releaseLong();
  await vi.advanceTimersByTimeAsync(0);
});
