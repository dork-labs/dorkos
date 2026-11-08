/**
 * The boot reconcile exactly as startup runs it (DOR-4002): the stores a boot
 * installs, the function `startup/steps/rooms.ts` calls, and a chat that
 * vanished while DorkOS was down losing its turn-context record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { runBootSessionReconcile } from '../catalog/boot-session-reconcile.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { StagedContextStore, setStagedContextStore } from '../staged-context-store.js';
import { setTurnContextStore } from '../turn-context/record-turn-context.js';
import { TurnContextStore } from '../turn-context/turn-context-store.js';

const LIVE = '00000000-0000-4000-8000-00000000live';
const GONE = '00000000-0000-4000-8000-00000000gone';
const BOOTED_AT = Date.parse('2026-11-08T12:00:00.000Z');

let db: Db;
let records: TurnContextStore;

beforeEach(() => {
  db = createTestDb();
  setMessageQueueStore(new MessageQueueStore(db));
  setStagedContextStore(new StagedContextStore(db));
  records = new TurnContextStore(db);
  setTurnContextStore(records);
  for (const sessionId of [LIVE, GONE]) {
    records.record({
      sessionId,
      runtime: 'claude-code',
      place: 'chat',
      systemSentThisTurn: true,
      parts: [{ slot: 'prompt', text: `made-up words for ${sessionId}` }],
    });
  }
});

afterEach(() => {
  setMessageQueueStore(undefined);
  setStagedContextStore(undefined);
  setTurnContextStore(null);
});

describe('the boot reconcile as startup wires it', () => {
  it('deletes the turn-context record, text included, of a chat that vanished while DorkOS was down', async () => {
    const report = await runBootSessionReconcile({
      bindingsFor: () =>
        new Map([
          [LIVE, { runtime: 'claude-code', boundAt: BOOTED_AT - 60_000 }],
          [GONE, { runtime: 'claude-code', boundAt: BOOTED_AT - 60_000 }],
        ]),
      claudeCodeInventory: () => Promise.resolve({ ids: new Set([LIVE]), complete: true }),
      bootedAt: BOOTED_AT,
    });

    expect(report).toMatchObject({ reaped: 1, failedDeletes: 0 });
    expect(records.listSessionIds()).toEqual([LIVE]);
    const bodies = db.$client.prepare('SELECT body FROM turn_context_bodies').all() as {
      body: string;
    }[];
    expect(bodies.map((row) => row.body)).toEqual([`made-up words for ${LIVE}`]);
  });

  it('is what startup calls: rooms.ts runs this function, with the host probes', () => {
    const rooms = fs.readFileSync(
      path.resolve(__dirname, '../../../startup/steps/rooms.ts'),
      'utf8'
    );
    expect(rooms).toMatch(/\brunBootSessionReconcile\(\{/);
    expect(rooms).not.toMatch(/\breconcileSessionRows\(/);
  });
});
