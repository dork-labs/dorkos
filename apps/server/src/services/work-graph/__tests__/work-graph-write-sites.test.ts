/**
 * The work graph's write sites: a chat's re-key (ADR-0267) and a fork
 * (DOR-4968), and a chat that starts a chat (DOR-5263). Each records its edge,
 * and none fails its action when the record cannot be written. And its one read site: `followChatRekey` answers an old
 * chat id from the recorded re-key once a restart has cleared the in-memory
 * redirect (DOR-5046).
 *
 * The re-key is driven through the real `createCanonicalRekey` and the real
 * projector registry, so the edge is proved to land where every caller's
 * re-key is made durable, not only when the participant is called by hand. A
 * start is driven through the real start-work seam over the real
 * `session_started_by` store, the path `session_start` and a carry-over take.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sql, workLinks, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import {
  createCanonicalRekey,
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  rekeyProjector,
} from '../../session/index.js';
import { StartWorkService } from '../../extensions/start-work.js';
import {
  onSessionStartRecorded,
  SessionStartedByStore,
} from '../../session/origin/session-started-by-store.js';
import { onDurableSessionRekey } from '../../session/turn-identity/durable-rekey.js';
import { followChatRekey } from '../../session/turn-identity/follow-chat-rekey.js';
import {
  getWorkLinkStore,
  installWorkLinkStore,
  recordChatFork,
  recordChatRekey,
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

describe('the re-key read site', () => {
  /** A re-keyed chat, then a restart: no projector, and a new store over the same database. */
  function rekeyThenRestart(): { requestId: string; canonicalId: string } {
    const turn = ids();
    rekeyTurn(turn.requestId, turn.canonicalId);
    disposeProjector(turn.canonicalId);
    expect(peekProjector(turn.requestId)).toBeUndefined();
    installWorkLinkStore(db);
    return turn;
  }

  it('answers an old chat id with the new one after a restart', () => {
    const { requestId, canonicalId } = rekeyThenRestart();
    expect(followChatRekey(requestId)).toBe(canonicalId);
    expect(followChatRekey(canonicalId)).toBe(canonicalId);
  });

  it('answers the id as given when the edges cannot be read', () => {
    const { requestId } = rekeyThenRestart();
    db.run(sql`DROP TABLE work_links`);
    expect(followChatRekey(requestId)).toBe(requestId);
  });

  it('keeps the first re-key when the same old id is re-keyed again', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { requestId, canonicalId } = rekeyThenRestart();
    const { canonicalId: otherId } = ids();
    recordChatRekey(requestId, otherId);
    expect(warn).toHaveBeenCalledWith('[work-graph] edge refused', {
      relation: 'rekeyed_from',
      oldId: requestId,
      newId: otherId,
      reason: 'already-rekeyed',
    });
    installWorkLinkStore(db);
    expect(followChatRekey(requestId)).toBe(canonicalId);
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

describe('the start write site', () => {
  /** The real start seam over the real `session_started_by` store; only starts are asked of it. */
  function startWork(): { service: StartWorkService; starts: SessionStartedByStore } {
    const starts = new SessionStartedByStore(db);
    const service = new StartWorkService({
      store: starts,
      projects: {
        rootWithin: async () => null,
        listForExtension: async () => [],
        list: async () => [],
      },
      extensionName: (id) => id,
      runningSessionIds: () => [],
      port: () => undefined,
    });
    return { service, starts };
  }

  /** Every `started` edge, as `starter -> chat`. */
  function startedEdges(): string[] {
    return db
      .select()
      .from(workLinks)
      .all()
      .filter((row) => row.relation === 'started')
      .map((row) => `${row.fromRef} -> ${row.toRef}`);
  }

  it('records the starting chat started the new one, with its started-by row', () => {
    const { service, starts } = startWork();
    const claimed = service.reserveFromChat({
      sessionId: 'child-chat',
      parentSessionId: 'parent-chat',
    });
    expect(claimed.ok).toBe(true);
    expect(starts.get('child-chat')).toMatchObject({
      kind: 'chat',
      startedBySessionId: 'parent-chat',
    });
    expect(getWorkLinkStore()!.from({ kind: 'chat', id: 'parent-chat' }, 'started')).toEqual([
      expect.objectContaining({ to: { kind: 'chat', id: 'child-chat' }, source: 'server' }),
    ]);
  });

  it('records nothing for a start no chat made, and says nothing about it', () => {
    const warn = vi.spyOn(logger, 'warn');
    const { service } = startWork();
    service.reserveUnattended('queued-chat');
    expect(
      service.reserve({
        sessionId: 'app-chat',
        kind: 'extension',
        extensionId: 'flow',
        startedBySessionId: null,
        originExtensionId: null,
        reason: null,
      }).ok
    ).toBe(true);
    expect(db.select().from(workLinks).all()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records nothing for a carry to another account: a move is not a start', () => {
    const { service, starts } = startWork();
    service.reserveFromChat({ sessionId: 'child-chat', parentSessionId: 'parent-chat' });
    const carried = service.reserveFromChat({
      sessionId: 'successor-chat',
      parentSessionId: 'child-chat',
      carry: true,
    });
    expect(carried.ok && carried.reservation).toBeTruthy();
    expect(starts.get('successor-chat')).toMatchObject({
      carried: true,
      startedBySessionId: 'child-chat',
    });
    expect(startedEdges()).toEqual(['dork:chat:parent-chat -> dork:chat:child-chat']);
  });

  it('records nothing new when the same start is recorded again', () => {
    const { service, starts } = startWork();
    service.reserveFromChat({ sessionId: 'child-chat', parentSessionId: 'parent-chat' });
    // The first starter stands, so a second claim from another chat is no start.
    service.reserveFromChat({ sessionId: 'child-chat', parentSessionId: 'other-chat' });
    expect(starts.get('child-chat')?.startedBySessionId).toBe('parent-chat');
    expect(startedEdges()).toEqual(['dork:chat:parent-chat -> dork:chat:child-chat']);
  });

  it('still starts the chat when the edge is refused or cannot be written', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { service, starts } = startWork();
    expect(
      service.reserveFromChat({ sessionId: 'child-chat', parentSessionId: 'not a chat id' }).ok
    ).toBe(true);
    db.run(sql`DROP TABLE work_links`);
    expect(
      service.reserveFromChat({ sessionId: 'later-chat', parentSessionId: 'parent-chat' }).ok
    ).toBe(true);
    expect(starts.get('child-chat')).not.toBeNull();
    expect(starts.get('later-chat')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[work-graph] a chat id has no reference form; edge not recorded',
      { relation: 'started', starterId: 'not a chat id', chatId: 'child-chat' }
    );
    expect(warn).toHaveBeenCalledWith(
      '[work-graph] could not record an edge',
      expect.objectContaining({
        relation: 'started',
        starterId: 'parent-chat',
        chatId: 'later-chat',
      })
    );
  });

  it('still starts the chat, and tells the other listeners, when a listener throws', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stopThrowing = onSessionStartRecorded(() => {
      throw new Error('listener broke');
    });
    const heard: string[] = [];
    const stopHearing = onSessionStartRecorded(({ sessionId }) => heard.push(sessionId));
    try {
      const { service, starts } = startWork();
      expect(
        service.reserveFromChat({ sessionId: 'child-chat', parentSessionId: 'parent-chat' }).ok
      ).toBe(true);
      expect(starts.get('child-chat')).not.toBeNull();
    } finally {
      stopThrowing();
      stopHearing();
    }
    expect(heard).toEqual(['child-chat']);
    expect(startedEdges()).toEqual(['dork:chat:parent-chat -> dork:chat:child-chat']);
  });
});
