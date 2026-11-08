/**
 * Turn the DM view on, once, for an install that never chose (DOR-3074).
 *
 * The `0.125.0` migration wrote `ui.dmView: false` into every stored config, so
 * flipping the default alone reaches only new installs. This is not a migration
 * key because a key runs before the database opens, and both facts it needs
 * live in the database:
 *
 * - **Did a person choose?** Every change made through the app or `dorkos config
 *   set` writes a `config.changed` audit row naming the field, and that table
 *   cannot be edited. A row for a leaf means somebody set it, so it is left
 *   alone. A hand edit of `config.json` leaves no row, and reads as not chosen.
 * - **Does this person go to sessions?** `session_touches` holds when a person
 *   opened a chat in the app. A Direct chat does not count, because it becomes
 *   the DM and is still there after the flip. Anyone who opened any other chat
 *   within {@link RECENT_OPEN_MS} of the upgrade keeps Show sessions, so nobody
 *   loses a habit overnight.
 *
 * Runs once per install, and the done file is what makes it once: a person who
 * turns the view off later must never be turned back on. Its own write records
 * audit rows, so a lost done file finds them and changes nothing. A new install
 * has nothing to change and only writes the done file.
 *
 * @module services/core/config/dm-view-upgrade
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, auditEvents, eq, gte, sessionTouches, sql, type Db } from '@dorkos/db';
import type { Logger } from '@dorkos/shared/logger';

/** How recently a chat must have been opened to keep Show sessions: 30 days. */
export const RECENT_OPEN_MS = 30 * 24 * 60 * 60 * 1000;

/** The one section this reads and writes, narrowed to what it needs. */
export interface DmViewUpgradeStore {
  /** The stored `ui` section. */
  get: (key: 'ui') => { dmView?: boolean; showSessions?: boolean } | undefined;
  /** Write one leaf. */
  setDot: (key: string, value: unknown) => unknown;
}

/** Everything the upgrade reads and writes through. */
export interface DmViewUpgradeDeps {
  /** The done file, inside DorkOS's data directory. */
  doneFile: string;
  /** The DorkOS database, already migrated. */
  db: Db;
  /** The settings. */
  store: DmViewUpgradeStore;
  /** Whether this session is the seat of a person's DM with one agent. */
  isDirectChat: (sessionId: string) => boolean;
  /** Records the change in the log and the audit trail. */
  recordWrite: (before: unknown, after: unknown) => void;
  /** Where the outcome is reported. */
  logger: Pick<Logger, 'info'>;
  /** The current time, in epoch ms. */
  now?: () => number;
}

/** What the upgrade changed; `null` when it had already run. */
export interface DmViewUpgradeResult {
  /** Whether it turned the DM view on. */
  dmView: boolean;
  /** Whether it turned Show sessions on. */
  showSessions: boolean;
}

/**
 * Whether the audit log holds a change to this setting.
 *
 * Narrowed with `instr`, then read properly, so a summary or another field's
 * value that merely mentions the name is not taken for a choice.
 */
function personChose(db: Db, field: string): boolean {
  const rows = db
    .select({ change: auditEvents.change })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.action, 'config.changed'), sql`instr(${auditEvents.change}, ${field}) > 0`)
    )
    .all();
  return rows.some(({ change }) => {
    const parsed: unknown = JSON.parse(change ?? '[]');
    return Array.isArray(parsed) && parsed.some((entry) => entry?.field === field);
  });
}

/** Whether a person opened any chat other than a Direct chat since this time. */
function openedSessionSince(
  db: Db,
  cutoffIso: string,
  isDirectChat: (sessionId: string) => boolean
): boolean {
  return db
    .select({ sessionId: sessionTouches.sessionId })
    .from(sessionTouches)
    .where(gte(sessionTouches.openedAt, cutoffIso))
    .all()
    .some(({ sessionId }) => !isDirectChat(sessionId));
}

/** Write the done file, atomically. */
function markDone(doneFile: string, result: DmViewUpgradeResult): void {
  fs.mkdirSync(path.dirname(doneFile), { recursive: true });
  const tmp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, doneAt: new Date().toISOString(), ...result })
  );
  fs.renameSync(tmp, doneFile);
}

/**
 * Run the upgrade, unless it already ran on this install.
 *
 * Throws when a record cannot be read, before anything is written, so the next
 * boot tries again rather than deciding without it.
 *
 * @param deps - The done file, database, settings, Direct chat check, recorder and logger.
 * @returns What changed, or `null` when it had already run.
 */
export function applyDmViewUpgrade(deps: DmViewUpgradeDeps): DmViewUpgradeResult | null {
  if (fs.existsSync(deps.doneFile)) return null;
  const now = deps.now?.() ?? Date.now();
  const before = deps.store.get('ui');
  const result: DmViewUpgradeResult = {
    dmView: before?.dmView === false && !personChose(deps.db, 'ui.dmView'),
    showSessions:
      before?.showSessions === false &&
      !personChose(deps.db, 'ui.showSessions') &&
      openedSessionSince(deps.db, new Date(now - RECENT_OPEN_MS).toISOString(), deps.isDirectChat),
  };
  if (result.dmView) deps.store.setDot('ui.dmView', true);
  if (result.showSessions) deps.store.setDot('ui.showSessions', true);
  if (result.dmView || result.showSessions) {
    deps.recordWrite(before, deps.store.get('ui'));
    deps.logger.info('[Config] Turned on the DM view for this install', { ...result });
  }
  markDone(deps.doneFile, result);
  return result;
}
