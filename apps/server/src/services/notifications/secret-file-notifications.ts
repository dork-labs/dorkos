/**
 * What DorkOS tells the person when an agent's folder holds files whose names
 * say they are secrets (DOR-3292). The emitter is
 * `services/core/secret-file-scan/secret-file-scan-service.ts`.
 *
 * Declared here and spread into the registry, like `web-device-notifications.ts`.
 *
 * No rule keeps an agent from reading a file inside its own folder, so the
 * only honest thing is to say so. The row names files by path, never by
 * contents, and only the person reads notifications. It never reaches a phone
 * or a room. Once per set of files for as long as the inbox keeps a row (its
 * retention): the dedupe key is the agent and a hash of the paths, so the same
 * files stay quiet across restarts, a new one is said at once, and files still
 * there after that are said again as a reminder.
 *
 * @module services/notifications/secret-file-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface SecretFilePayloads {
  /** An agent's folder holds secret-looking files it can read. */
  'agent.secret_files': {
    /** The agent. The subject. */
    agentId: string;
    /** Its display name. */
    agentName: string;
    /**
     * Paths relative to the agent's folder, at most {@link SECRET_FILES_LISTED},
     * with control and direction characters already replaced. Never contents.
     */
    files: string[];
    /** How many were found, which may be more than are listed. */
    total: number;
    /** A hash of every path found, so the same set is said once. */
    fingerprint: string;
  };
}

/**
 * A file name as the person may read it: control, format and line-break
 * characters (right-to-left overrides, zero-width marks) replaced, so a name
 * a cloned repo chose cannot fake the rest of the title.
 *
 * @param name - A file name or relative path.
 */
export function shownName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
}

/** The most paths one row carries. */
export const SECRET_FILES_LISTED = 20;

/** How many paths the row's meta line names before it says "+N more". */
const SECRET_FILES_IN_META = 2;

/**
 * The row's meta line when there are several files: the first few paths, then
 * how many more, e.g. `.env · apps/web/.env.local · +2 more`. Nothing for one
 * file, which the title already names.
 *
 * @param p - The notice's payload.
 */
export function secretFilesMeta(p: SecretFilePayloads['agent.secret_files']): string | undefined {
  if (p.total <= 1) return undefined;
  const named = p.files.slice(0, SECRET_FILES_IN_META).map(shownName);
  const more = p.total - named.length;
  return [...named, ...(more > 0 ? [`+${more} more`] : [])].join(' · ');
}

/**
 * As long as the inbox keeps a row (`NOTIFICATION_RETENTION_DAYS`, 30): a
 * longer window would claim a silence the store cannot keep, since dedupe
 * reads the stored rows. Written out, not imported, because the store imports
 * the registry; a test pins the two together.
 */
export const SECRET_FILES_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000;

/** The one entry, spread into the registry's `ENTRIES`. */
export const SECRET_FILE_ENTRIES: {
  [K in keyof SecretFilePayloads]: NotificationRegistryEntry<K>;
} = {
  'agent.secret_files': {
    kind: 'agent.secret_files',
    // Notable: it lands in the inbox and never reaches a phone.
    tier: 'notable',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId }),
    // One file: its path inside the folder, so `apps/web/.env` is not just `.env`.
    title: (p) =>
      p.total === 1 && p.files[0]
        ? `${p.agentName} can read ${shownName(p.files[0])} in its folder`
        : `${p.agentName} can read ${p.total} secret files in its folder`,
    // The designer's `row.line.unbounded` (spec v0.3.6): no advice the agent
    // can step around. Today it reads outside its folder too (Full, and the
    // shell until DOR-3300), so moving a file keeps it out of searches through
    // the folder and nothing more, and the line says exactly that.
    // It ends on what the person does, by hand: there is no Move action (part 1).
    body: (p) =>
      p.total === 1
        ? `Move it out of its folder to keep it out of its searches. ${p.agentName} may still be able to read it.`
        : `Move them out of its folder to keep them out of its searches. ${p.agentName} may still be able to read them.`,
    dedupeKey: (p) => `secret-files:${p.agentId}:${p.fingerprint}`,
    dedupeWindowMs: SECRET_FILES_DEDUPE_MS,
    relay: 'never',
  },
};
