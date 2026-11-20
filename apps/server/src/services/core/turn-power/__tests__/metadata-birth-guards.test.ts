/** Marker and hold evidence never substitutes for a real first-writer owner. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, sessionBirthAllocations, sessionMetadata } from '@dorkos/db';
import { logger } from '../../../../lib/logger.js';
import { createChatRiseFacts } from '../chat-rise-facts.js';
import {
  bridgedSenderVouched,
  carryBridgedSender,
  chatHeldStrangerWords,
  lastTurnHeld,
  noteBridgedSender,
  noteTurnHold,
  setContinuationHoldDb,
} from '../continuation-hold.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
  setContinuationHoldDb(db);
  resetSessionKeys();
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  resetSessionKeys();
  vi.restoreAllMocks();
  db.$client.close();
});
const row = (id: string) =>
  db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
function allocate(id: string) {
  db.insert(sessionBirthAllocations)
    .values({
      sessionId: id,
      version: 1,
      createdAt: 'owned',
      sourceKind: 'internal',
      internalSource: { kind: 'server-mint', owner: 'chat-start', mintedSessionId: id },
    })
    .run();
}
const writers = {
  person: (id: string) => createChatRiseFacts(db).notePersonSetMode(id),
  turn: (id: string) => noteTurnHold(id, true),
  bridge: (id: string) => noteBridgedSender(id, { marked: true, bridged: true }),
  alias: (id: string) => carryBridgedSender('source', id),
};

it.each(Object.keys(writers) as Array<keyof typeof writers>)(
  '%s refuses an available allocation without owner context and retains its warning',
  (writer) => {
    db.insert(sessionMetadata)
      .values({ sessionId: 'source', runtime: null, createdAt: 'old', bridgedSender: 'stranger' })
      .run();
    allocate('fresh');
    const before = db.select().from(sessionBirthAllocations).all();
    const warning = vi.spyOn(logger, 'warn');
    expect(() => writers[writer]('fresh')).not.toThrow();
    expect(row('fresh')).toBeUndefined();
    expect(db.select().from(sessionBirthAllocations).all()).toEqual(before);
    expect(warning).toHaveBeenCalledTimes(1);
  }
);

it.each(Object.keys(writers) as Array<keyof typeof writers>)(
  '%s preserves its ordinary legacy insert without pending proof',
  (writer) => {
    db.insert(sessionMetadata)
      .values({ sessionId: 'source', runtime: null, createdAt: 'old', bridgedSender: 'stranger' })
      .run();
    writers[writer]('legacy');
    expect(row('legacy')).toMatchObject({ runtime: null, modelLaunchState: null });
    if (writer === 'person') expect(row('legacy')?.permissionModeByPerson).toBe(true);
    if (writer === 'turn') expect(row('legacy')?.lastTurnHeld).toBe(true);
    if (writer === 'bridge' || writer === 'alias')
      expect(row('legacy')?.bridgedSender).toBe('stranger');
  }
);

it('keeps stranger cache conservative after a refused bridge write', () => {
  allocate('fresh');
  noteBridgedSender('fresh', { marked: true, bridged: true });
  expect(row('fresh')).toBeUndefined();
  expect(chatHeldStrangerWords('fresh')).toBe(true);
  expect(bridgedSenderVouched('fresh')).toBe(false);
});

it('does not mark the hold cache written after a refused first insert', () => {
  allocate('fresh');
  noteTurnHold('fresh', true);
  expect(row('fresh')).toBeUndefined();
  expect(lastTurnHeld('fresh')).toBe(false);
  db.delete(sessionBirthAllocations).where(eq(sessionBirthAllocations.sessionId, 'fresh')).run();
  noteTurnHold('fresh', true);
  expect(row('fresh')?.lastTurnHeld).toBe(true);
  expect(lastTurnHeld('fresh')).toBe(true);
});

it('does not infer alias authority from an inconsistent source allocation', () => {
  db.insert(sessionMetadata)
    .values({
      sessionId: 'source',
      runtime: null,
      createdAt: 'old',
      bridgedSender: 'stranger',
      modelLaunchState: 'established-v1',
    })
    .run();
  allocate('source');
  carryBridgedSender('source', 'renamed');
  expect(row('renamed')).toBeUndefined();
  expect(row('source')?.modelLaunchState).toBe('established-v1');
  expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);
});

it('refuses the hold for every alias while the primary has an outstanding allocation', () => {
  linkSessionId('primary', 'alias');
  allocate('primary');
  createChatRiseFacts(db).notePersonSetMode('alias');
  noteTurnHold('alias', true);
  expect(row('primary')).toBeUndefined();
  expect(row('alias')).toBeUndefined();
  expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);

  db.delete(sessionBirthAllocations).where(eq(sessionBirthAllocations.sessionId, 'primary')).run();
  noteTurnHold('alias', true);
  expect(row('primary')).toMatchObject({ lastTurnHeld: true, modelLaunchState: null });
  expect(row('alias')).toMatchObject({ lastTurnHeld: true, modelLaunchState: null });
});

it('rolls back an actual hold insert failure and retries its unchanged cache path', () => {
  db.$client.exec(
    "CREATE TEMP TRIGGER reject_hold_write BEFORE INSERT ON session_metadata WHEN NEW.session_id = 'held' BEGIN SELECT RAISE(ABORT, 'owned-hold-write-refused'); END;"
  );
  noteTurnHold('held', true);
  expect(row('held')).toBeUndefined();
  db.$client.exec('DROP TRIGGER reject_hold_write');
  noteTurnHold('held', true);
  expect(row('held')).toMatchObject({ lastTurnHeld: true, modelLaunchState: null });
});
