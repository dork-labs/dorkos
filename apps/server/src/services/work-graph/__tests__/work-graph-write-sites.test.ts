/**
 * The work graph's two write sites (DOR-4968): a chat's re-key (ADR-0267) and a
 * fork. Each records its edge, and neither fails its action when the record
 * cannot be written.
 *
 * The re-key is driven through the real `createCanonicalRekey` and the real
 * projector registry, so the edge is proved to land where every caller's
 * re-key is made durable, not only when the participant is called by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sql, workLinks, type Db } from '@dorkos/db';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import {
  createCanonicalRekey,
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  rekeyProjector,
} from '../../session/index.js';
import { onDurableSessionRekey } from '../../session/turn-identity/durable-rekey.js';
import {
  getWorkLinkStore,
  installWorkLinkStore,
  recordChatFork,
  uninstallWorkLinkStore,
  WorkLinkStore,
} from '../index.js';

let db: Db;
let seq = 0;

/** A fresh request id and canonical id per test, so the projector registry never collides. */
function ids(): { requestId: string; canonicalId: string } {
  seq += 1;
  return { requestId: `request-${seq}`, canonicalId: `canonical-${seq}` };
}

/** Run one turn's re-key step the way `triggerTurn` and the task runner do. */
function rekeyTurn(requestId: string, canonicalId: string): string {
  getOrCreateProjector(requestId, '/projects/x');
  let key = requestId;
  const step = createCanonicalRekey({
    sessionId: requestId,
    clientId: 'client-1',
    holder: {} as SseResponse,
    lockToken: Symbol('turn'),
    turnKey: () => key,
    onTurnKey: (next) => {
      key = next;
    },
    chain: { link: () => {} },
    deps: {
      getInternalSessionId: () => canonicalId,
      rekeyProjector,
      acquireLock: () => true,
      releaseLock: () => {},
    },
  });
  step();
  return key;
}

beforeEach(() => {
  db = createTestDb();
  installWorkLinkStore(db);
});

afterEach(() => {
  uninstallWorkLinkStore();
  vi.restoreAllMocks();
});

describe('the re-key write site', () => {
  it('records the new id rekeyed_from the old one, so the old id can be resolved after a restart', () => {
    const { requestId, canonicalId } = ids();
    expect(rekeyTurn(requestId, canonicalId)).toBe(canonicalId);
    expect(getWorkLinkStore()!.from({ kind: 'chat', id: canonicalId })).toEqual([
      expect.objectContaining({
        relation: 'rekeyed_from',
        to: { kind: 'chat', id: requestId },
        source: 'server',
        recordingChatId: null,
      }),
    ]);
    disposeProjector(canonicalId);
    // A restart: the in-memory redirect is gone; the edge is not.
    expect(new WorkLinkStore({ db }).resolveRekey(requestId)).toBe(canonicalId);
  });

  it('still re-keys the chat, and runs the participants after it, when the edge cannot be written', () => {
    const later: Array<[string, string]> = [];
    const stopLater = onDurableSessionRekey((oldId, newId) => later.push([oldId, newId]));
    db.run(sql`DROP TABLE work_links`);
    const { requestId, canonicalId } = ids();
    try {
      expect(rekeyTurn(requestId, canonicalId)).toBe(canonicalId);
    } finally {
      stopLater();
    }
    expect(later).toEqual([[requestId, canonicalId]]);
    const moved = peekProjector(canonicalId);
    expect(moved).toBeDefined();
    // The old id now only redirects to the moved projector.
    expect(peekProjector(requestId)).toBe(moved);
    disposeProjector(canonicalId);
  });

  it('records nothing once the store is uninstalled', () => {
    uninstallWorkLinkStore();
    const { requestId, canonicalId } = ids();
    rekeyTurn(requestId, canonicalId);
    disposeProjector(canonicalId);
    expect(db.select().from(workLinks).all()).toEqual([]);
  });

  it('registers its participant once however often the store is installed', () => {
    installWorkLinkStore(db);
    installWorkLinkStore(db);
    // Rows cannot tell: an exact repeat lands no second row. The calls can.
    const record = vi.spyOn(WorkLinkStore.prototype, 'record');
    const { requestId, canonicalId } = ids();
    rekeyTurn(requestId, canonicalId);
    disposeProjector(canonicalId);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('the fork write site', () => {
  it('records the fork forked_from its source', () => {
    recordChatFork('source-chat', 'fork-chat');
    expect(getWorkLinkStore()!.to({ kind: 'chat', id: 'source-chat' }, 'forked_from')).toEqual([
      expect.objectContaining({ from: { kind: 'chat', id: 'fork-chat' }, source: 'server' }),
    ]);
  });

  it('never throws, whether the ids are bad or the table is gone', () => {
    expect(() => recordChatFork('source-chat', 'not a chat id')).not.toThrow();
    db.run(sql`DROP TABLE work_links`);
    expect(() => recordChatFork('source-chat', 'fork-chat')).not.toThrow();
  });
});
