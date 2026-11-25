/**
 * The lineage query's test stores: a fresh SQLite database per test, the work
 * graph installed over it, and the real start-work seam, so each start leaves
 * both its `session_started_by` row and its `started` link, as
 * `session_start` does. A chat "ran" once its `session_metadata` row is bound
 * to a runtime, as a chat's first turn binds it.
 */
import { afterEach, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import { StartWorkService, setStartWorkService } from '../../extensions/start-work.js';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../session/origin/session-started-by-store.js';
import { setWorkClaims } from '../../session/claims/work-claim-current.js';
import { RunStore } from '../../runs/index.js';
import {
  ChatLineageReader,
  getWorkLinkStore,
  installWorkLinkStore,
  uninstallWorkLinkStore,
  WorkLinkStore,
  type ChatLineage,
} from '../index.js';

/** The stores of the running test. */
export interface LineageStores {
  db: Db;
  starts: SessionStartedByStore;
  service: StartWorkService;
  runs: RunStore;
}

/** The running test's stores, set by {@link useLineageStores}. */
export const stores = {} as LineageStores;

/** One clock for every start, one second apart, so siblings list oldest first. */
let clock = 0;

/** The next start's time, as ISO 8601. */
export function tick(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

/** Give each test in the file fresh stores, and clear what they wired afterwards. */
export function useLineageStores(): void {
  beforeEach(() => {
    const db = createTestDb();
    clock = Date.parse('2026-11-25T10:00:00.000Z');
    installWorkLinkStore(db);
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
      now: () => Date.parse(tick()),
    });
    Object.assign(stores, { db, starts, service, runs: new RunStore(db, { epoch: 'boot-1' }) });
  });
  afterEach(() => {
    uninstallWorkLinkStore();
    setStartWorkService(undefined);
    setSessionStartedByStore(undefined);
    setWorkClaims(undefined);
  });
}

/** The reader over every store, the way `readChatLineage` builds it. */
export function reader(opts: { startedBy?: boolean } = {}): ChatLineageReader {
  const { db, starts, runs } = stores;
  return new ChatLineageReader({
    db,
    links: getWorkLinkStore() ?? new WorkLinkStore({ db }),
    ...(opts.startedBy === false ? {} : { startedBy: starts }),
    runs,
  });
}

/** `parent` starts `child` through the start-work seam, as `session_start` does. */
export function start(parent: string, child: string, opts: { carry?: boolean } = {}) {
  const claimed = stores.service.reserveFromChat({
    sessionId: child,
    parentSessionId: parent,
    ...(opts.carry ? { carry: true } : {}),
  });
  if (!claimed.ok || claimed.reservation === null) throw new Error(`could not start ${child}`);
  return claimed.reservation;
}

/** These chats ran: their first turn bound them to a runtime. */
export function ran(...ids: string[]): void {
  for (const sessionId of ids) {
    stores.db
      .insert(sessionMetadata)
      .values({ sessionId, runtime: 'claude-code', createdAt: new Date(clock).toISOString() })
      .run();
  }
}

/** How each state reads in {@link tree} and {@link up}: `!` never started, `~` launching, `?` unknown. */
const MARK = { chat: '', 'never-started': '!', launching: '~', unknown: '?' } as const;

/** Each descendant as `depth:id<-parent(via)`, marked by its state. */
export function tree(lineage: ChatLineage | null): string[] {
  return (lineage?.descendants ?? []).map(
    (d) => `${d.depth}:${d.chatId}<-${d.parentId}(${d.via})${MARK[d.state.kind]}`
  );
}

/** Each ancestor as `depth:id(via)`, marked by its state. */
export function up(lineage: ChatLineage | null): string[] {
  return (lineage?.ancestors ?? []).map(
    (a) => `${a.depth}:${a.chatId}(${a.via})${MARK[a.state.kind]}`
  );
}
