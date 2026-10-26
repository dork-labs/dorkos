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
import path from 'node:path';
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface SecretFilePayloads {
  /** An agent's folder holds secret-looking files it can read. */
  'agent.secret_files': {
    /** The agent. The subject. */
    agentId: string;
    /** Its display name. */
    agentName: string;
    /** Absolute paths, at most {@link SECRET_FILES_LISTED}. Never contents. */
    files: string[];
    /** How many were found, which may be more than are listed. */
    total: number;
    /** A hash of every path found, so the same set is said once. */
    fingerprint: string;
  };
}

/** The most paths one row carries. */
export const SECRET_FILES_LISTED = 20;

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
    title: (p) =>
      p.total === 1 && p.files[0]
        ? `${p.agentName} can read ${path.basename(p.files[0])} in its folder`
        : `${p.agentName} can read ${p.total} secret files in its folder`,
    body: () => "Rules can't stop that. Move them somewhere the agent can't reach.",
    dedupeKey: (p) => `secret-files:${p.agentId}:${p.fingerprint}`,
    dedupeWindowMs: SECRET_FILES_DEDUPE_MS,
    relay: 'never',
  },
};
