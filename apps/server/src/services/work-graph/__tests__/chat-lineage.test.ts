/**
 * The lineage query (W3, DOR-4969): a chat's ancestors and its whole subtree
 * with depth, over the real SQLite stores. Starts are made through the real
 * start-work seam with the work graph installed, so each one leaves both its
 * `session_started_by` row and its `started` link, as `session_start` does.
 * A chat "exists" once its `session_metadata` row is bound to a runtime, as a
 * chat's first turn binds it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, workLinks, type Db } from '@dorkos/db';
import { StartWorkService, setStartWorkService } from '../../extensions/start-work.js';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../session/origin/session-started-by-store.js';
import { WorkClaimService } from '../../session/claims/work-claim-service.js';
import { setWorkClaims } from '../../session/claims/work-claim-current.js';
import { claimForStart } from '../../session/claims/work-claim-start.js';
import { reserveChatStart } from '../../runtimes/claude-code/mcp-tools/session-start-reserve.js';
import { RunStore } from '../../runs/index.js';
import {
  ChatLineageReader,
  getWorkLinkStore,
  installWorkLinkStore,
  readChatLineage,
  recordChatRekey,
  uninstallWorkLinkStore,
  WorkLinkStore,
  type ChatLineage,
} from '../index.js';

let db: Db;
let starts: SessionStartedByStore;
let service: StartWorkService;
let runs: RunStore;
let clock: number;

beforeEach(() => {
  db = createTestDb();
  clock = Date.parse('2026-11-25T10:00:00.000Z');
  installWorkLinkStore(db);
  starts = new SessionStartedByStore(db);
  service = new StartWorkService({
    store: starts,
    projects: {
      rootWithin: async () => null,
      listForExtension: async () => [],
      list: async () => [],
    },
    extensionName: (id) => id,
    runningSessionIds: () => [],
    port: () => undefined,
    // One second per start, so siblings list oldest first.
    now: () => (clock += 1000),
  });
  runs = new RunStore(db, { epoch: 'boot-1' });
});

afterEach(() => {
  uninstallWorkLinkStore();
  setStartWorkService(undefined);
  setSessionStartedByStore(undefined);
  setWorkClaims(undefined);
});

/** The reader over every store, the way `readChatLineage` builds it. */
function reader(opts: { startedBy?: boolean } = {}): ChatLineageReader {
  return new ChatLineageReader({
    db,
    links: getWorkLinkStore() ?? new WorkLinkStore({ db }),
    ...(opts.startedBy === false ? {} : { startedBy: starts }),
    runs,
  });
}

/** `parent` starts `child` through the start-work seam, as `session_start` does. */
function start(parent: string, child: string, opts: { carry?: boolean } = {}) {
  const claimed = service.reserveFromChat({
    sessionId: child,
    parentSessionId: parent,
    ...(opts.carry ? { carry: true } : {}),
  });
  if (!claimed.ok || claimed.reservation === null) throw new Error(`could not start ${child}`);
  return claimed.reservation;
}

/** These chats ran: their first turn bound them to a runtime. */
function ran(...ids: string[]): void {
  for (const sessionId of ids) {
    db.insert(sessionMetadata)
      .values({ sessionId, runtime: 'claude-code', createdAt: new Date(clock).toISOString() })
      .run();
  }
}

/** Each descendant as `depth:id<-parent(via)`, with `!` for a chat that never started. */
function tree(lineage: ChatLineage | null): string[] {
  return (lineage?.descendants ?? []).map(
    (d) =>
      `${d.depth}:${d.chatId}<-${d.parentId}(${d.via})${d.state.kind === 'never-started' ? '!' : ''}`
  );
}

/** Each ancestor as `depth:id(via)`. */
function up(lineage: ChatLineage | null): string[] {
  return (lineage?.ancestors ?? []).map((a) => `${a.depth}:${a.chatId}(${a.via})`);
}

describe('a chat tree', () => {
  /** root → a → a1 → a1x → deep, and root → b → b1. */
  function plant(): void {
    start('root', 'a');
    start('a', 'a1');
    start('root', 'b');
    start('a1', 'a1x');
    start('b', 'b1');
    start('a1x', 'deep');
    ran('root', 'a', 'a1', 'b', 'a1x', 'b1', 'deep');
  }

  it('returns the whole subtree, depth first, with each chat’s depth', () => {
    plant();
    expect(tree(reader().read('root'))).toEqual([
      '1:a<-root(started)',
      '2:a1<-a(started)',
      '3:a1x<-a1(started)',
      '4:deep<-a1x(started)',
      '1:b<-root(started)',
      '2:b1<-b(started)',
    ]);
  });

  it('returns the ancestors of the deepest chat, nearest first', () => {
    plant();
    const lineage = reader().read('deep');
    expect(up(lineage)).toEqual([
      '1:a1x(started)',
      '2:a1(started)',
      '3:a(started)',
      '4:root(started)',
    ]);
    expect(lineage?.descendants).toEqual([]);
  });

  it('goes only as deep as the caller asks', () => {
    plant();
    expect(tree(reader().read('root', { depth: 1 }))).toEqual([
      '1:a<-root(started)',
      '1:b<-root(started)',
    ]);
    expect(tree(reader().read('a', { depth: 2 }))).toEqual([
      '1:a1<-a(started)',
      '2:a1x<-a1(started)',
    ]);
  });

  it('lets a childrenOf caller ask for any depth', () => {
    plant();
    expect(starts.childrenOf('root')).toEqual(['a', 'b']);
    expect(starts.childrenOf('root', 2)).toEqual(['a', 'b', 'a1', 'b1']);
    expect(starts.childrenOf('root', Infinity)).toEqual(['a', 'b', 'a1', 'b1', 'a1x', 'deep']);
  });

  it('answers null for a chat with neither a chat nor a run', () => {
    expect(reader().read('nobody')).toBeNull();
  });
});

describe('a cycle in the records', () => {
  it('ends the walk, listing each chat once, up and down', () => {
    const links = getWorkLinkStore()!;
    for (const [from, to] of [
      ['x', 'y'],
      ['y', 'z'],
      ['z', 'x'],
    ] as const) {
      expect(
        links.record({
          from: { kind: 'chat', id: from },
          relation: 'started',
          to: { kind: 'chat', id: to },
          source: 'server',
        }).ok
      ).toBe(true);
    }
    ran('x', 'y', 'z');
    const lineage = reader().read('x');
    expect(tree(lineage)).toEqual(['1:y<-x(started)', '2:z<-y(started)']);
    expect(up(lineage)).toEqual(['1:z(started)', '2:y(started)']);
  });

  it('ends childrenOf at any depth too', () => {
    for (const [parent, child] of [
      ['x', 'y'],
      ['y', 'x'],
    ] as const) {
      starts.insert({
        sessionId: child,
        kind: 'chat',
        extensionId: null,
        startedBySessionId: parent,
        originExtensionId: null,
        reason: null,
        createdAt: new Date((clock += 1000)).toISOString(),
      });
    }
    // A bounded depth first, so a broken guard fails here rather than looping forever below.
    expect(starts.childrenOf('x', 50)).toEqual(['y']);
    expect(starts.childrenOf('x', Infinity)).toEqual(['y']);
  });
});

describe('a carry to another account', () => {
  it('is followed into everything the successor chat starts', () => {
    start('root', 'moved');
    start('moved', 'successor', { carry: true });
    start('successor', 'grandchild');
    ran('root', 'moved', 'successor', 'grandchild');
    // A carry wrote no started link: only the two real starts did.
    expect(
      db
        .select()
        .from(workLinks)
        .all()
        .map((row) => row.toRef)
    ).toEqual(['dork:chat:moved', 'dork:chat:grandchild']);
    expect(tree(reader().read('root'))).toEqual([
      '1:moved<-root(started)',
      '2:successor<-moved(carried)',
      '3:grandchild<-successor(started)',
    ]);
    expect(up(reader().read('grandchild'))).toEqual([
      '1:successor(started)',
      '2:moved(carried)',
      '3:root(started)',
    ]);
  });
});

describe('a start that never ran', () => {
  it('is left out when session_start cancels it because another chat of the agent holds the work', async () => {
    setSessionStartedByStore(starts);
    setStartWorkService(service);
    const claims = new WorkClaimService({ db });
    setWorkClaims(claims);
    expect(claims.claim('agent-1', 'holder', 'DOR-1').ok).toBe(true);
    start('root', 'sibling');
    ran('root', 'holder', 'sibling');

    // session_start's steps, in its order: the start is reserved, then the work is found held.
    const claimed = reserveChatStart({
      sessionId: 'turned-away',
      parentSessionId: 'root',
      reason: undefined,
      permission: { mode: 'default', label: 'Default', callerMode: 'default', sameAsCaller: true },
      reportBack: true,
      taskStore: undefined,
    });
    expect(claimed.ok).toBe(true);
    const held = await claimForStart({
      args: { claim: 'DOR-1' },
      agentId: 'agent-1',
      agentPath: '/agents/one',
      callerSessionId: 'root',
      sessionId: 'turned-away',
    });
    expect(held).not.toBeNull();
    if (claimed.ok) claimed.reservation?.cancel();

    // The start's link outlives the cancel (the table is append-only); its row does not.
    expect(getWorkLinkStore()!.from({ kind: 'chat', id: 'root' }, 'started')).toEqual([
      expect.objectContaining({ to: { kind: 'chat', id: 'sibling' } }),
      expect.objectContaining({ to: { kind: 'chat', id: 'turned-away' } }),
    ]);
    expect(starts.get('turned-away')).toBeNull();
    expect(tree(readChatLineage('root'))).toEqual(['1:sibling<-root(started)']);
    expect(readChatLineage('turned-away')).toBeNull();
  });

  it('is shown as never started, with the run’s reason, when its run ended before it started', () => {
    const reservation = start('root', 'expired-chat');
    ran('root');
    const run = runs.create({
      chatKey: 'expired-chat',
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    runs.move(run, 'cancelled', {
      endedAt: runs.stamp(),
      endingDetail: { cancelledBecause: 'expired' },
    });
    // What start-work does when the run ends unstarted: the row goes, the link stays.
    reservation.cancel();
    const lineage = reader().read('root');
    expect(tree(lineage)).toEqual(['1:expired-chat<-root(started)!']);
    expect(lineage?.descendants[0]?.state).toEqual({
      kind: 'never-started',
      runId: run.id,
      reason: 'expired',
    });
  });
});

describe('a re-keyed child', () => {
  it('is found through rekeyed_from when its started link names its pre-launch id', () => {
    const reservation = start('root', 'pre-launch');
    // The runtime settled on another id: the row moves, and the re-key is recorded.
    reservation.rekey('runtime-id');
    recordChatRekey('pre-launch', 'runtime-id');
    ran('root', 'runtime-id');
    expect(getWorkLinkStore()!.from({ kind: 'chat', id: 'root' }, 'started')).toEqual([
      expect.objectContaining({ to: { kind: 'chat', id: 'pre-launch' } }),
    ]);
    // From the link alone, as after session_started_by lets the row go.
    expect(tree(reader({ startedBy: false }).read('root'))).toEqual([
      '1:runtime-id<-root(started)',
    ]);
    // From both, it is still one chat.
    expect(tree(reader().read('root'))).toEqual(['1:runtime-id<-root(started)']);
    expect(up(reader({ startedBy: false }).read('pre-launch'))).toEqual(['1:root(started)']);
  });
});

describe('a chat started before DOR-5263', () => {
  it('is found through session_started_by alone', () => {
    uninstallWorkLinkStore();
    starts.insert({
      sessionId: 'old-child',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'old-root',
      originExtensionId: null,
      reason: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    ran('old-root', 'old-child');
    expect(db.select().from(workLinks).all()).toEqual([]);
    expect(tree(reader().read('old-root'))).toEqual(['1:old-child<-old-root(started)']);
    expect(up(reader().read('old-child'))).toEqual(['1:old-root(started)']);
  });
});
