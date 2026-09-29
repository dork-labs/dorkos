/**
 * A real inbox on a real database, with the notification pipeline and the
 * escalation ladder wired, for the `ctx.inbox` tests (spec
 * `flow-multiproject` §7). Only the edges are fakes: the project registry
 * (two repos under `/repos`), the folder check, and the phone.
 */
import { vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { notifications, type Db } from '@dorkos/db';
import type { ProjectInfo, ProjectRef } from '@dorkos/extension-api/server';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import {
  EscalationService,
  setEscalationService,
} from '../../../notifications/escalation-service.js';
import type { WebPushChannel } from '../../../notifications/channels/web-push.js';
import {
  ExtensionInboxService,
  setExtensionInbox,
  type ExtensionInboxDeps,
} from '../extension-inbox.js';

/** Two projects: `/repos/dorkos` and `/repos/blintz`. Anything else is in no repo. */
export const PROJECTS: Record<string, ProjectRef> = {
  '/repos/dorkos': { root: '/repos/dorkos', name: 'dorkos' },
  '/repos/blintz': { root: '/repos/blintz', name: 'blintz' },
};

/** The project a path is in, by prefix. */
function projectFor(dir: string): ProjectRef | null {
  for (const [root, ref] of Object.entries(PROJECTS)) {
    if (dir === root || dir.startsWith(`${root}/`)) return ref;
  }
  return null;
}

/** Everything a test reaches into. */
export interface InboxFixture {
  db: Db;
  store: NotificationStore;
  inbox: ExtensionInboxService;
  /** The phone leg. */
  sendToAll: ReturnType<typeof vi.fn>;
  /** Every `eventFanOut.broadcast` call. */
  broadcast: ReturnType<typeof vi.spyOn>;
  /** Folders that are missing (an unplugged drive). */
  missing: Set<string>;
  /** Projects each extension may see (holds a copy, or reported). */
  scope: Map<string, string[]>;
  /** Build a second service on the same database, as a restart would. */
  restart: (overrides?: Partial<ExtensionInboxDeps>) => ExtensionInboxService;
  /** Stored `extension.decision` history rows, oldest first. */
  history: () => Array<typeof notifications.$inferSelect>;
  /** `standing_pending` broadcasts of `extension.decision`. */
  pendingEvents: () => Array<{ subjectKey: string; title: string }>;
  /** Tear down. */
  close: () => void;
}

/**
 * Build the fixture. Call inside `beforeEach`, after `vi.useFakeTimers()` when
 * the test needs them.
 *
 * @param overrides - Service dependencies to replace.
 */
export function createInboxFixture(overrides: Partial<ExtensionInboxDeps> = {}): InboxFixture {
  const db = createTestDb();
  const store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));
  const sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
  setEscalationService(
    new EscalationService({
      store,
      push: { sendToAll } as unknown as WebPushChannel,
      relay: () => undefined,
      readDelay: () => 2,
    })
  );
  const broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  const missing = new Set<string>();
  const scope = new Map<string, string[]>([['flow', ['/repos/dorkos', '/repos/blintz']]]);

  const projects: ExtensionInboxDeps['projects'] = {
    report: async (dir: string) => projectFor(dir),
    get: (root: string) => {
      const ref = PROJECTS[root];
      return ref ? ({ ...ref, originRepo: null, lastSeenAt: '' } satisfies ProjectInfo) : undefined;
    },
    resolveWithin: async (dir: string) => projectFor(dir),
    listForExtension: async (extensionId: string) =>
      (scope.get(extensionId) ?? []).map((root) => ({
        ...PROJECTS[root],
        originRepo: null,
        lastSeenAt: '',
      })),
  };

  const build = (more: Partial<ExtensionInboxDeps> = {}) =>
    new ExtensionInboxService({
      db,
      projects,
      dorkHome: '/tmp/dork-home-unused',
      folderExists: (root) => !missing.has(root),
      watchAllowed: () => true,
      ...overrides,
      ...more,
    });

  const inbox = build();
  setExtensionInbox(inbox);

  return {
    db,
    store,
    inbox,
    sendToAll,
    broadcast,
    missing,
    scope,
    restart: (more) => {
      const next = build(more);
      setExtensionInbox(next);
      return next;
    },
    history: () =>
      db
        .select()
        .from(notifications)
        .all()
        .filter((row) => row.kind === 'extension.decision'),
    pendingEvents: () =>
      broadcast.mock.calls
        .filter(
          ([event, data]) =>
            event === 'standing_pending' && (data as { kind: string }).kind === 'extension.decision'
        )
        .map(([, data]) => data as { subjectKey: string; title: string }),
    close: () => {
      setExtensionInbox(null);
      setEscalationService(null);
      setNotificationService(null);
      broadcast.mockRestore();
    },
  };
}

/** Let fire-and-forget promises settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A yes-or-no decision with a reason. */
export function shipDecision(overrides: Record<string, unknown> = {}) {
  return {
    key: 'ship:DOR-2387',
    title: 'Ship the new out-of-usage banner?',
    why: "It's built, tests pass, and the reviewer agent found nothing. Shipping merges it.",
    project: '/repos/dorkos/apps/client',
    projectLabel: 'Linear DOR',
    actions: { kind: 'yes-no' as const, approveLabel: 'Ship it', rejectLabel: 'Send it back' },
    link: '/x/flow/p/dorkos',
    ...overrides,
  };
}
