/**
 * The Activity line for a secret file that appeared between two renders of
 * one Codex chat's macOS profile (DOR-4358).
 *
 * On macOS the profile names each secret file exactly (`expand-deep-globs.ts`)
 * and renders again on every turn. A file that appears while a turn runs is
 * not named until the next render, so that turn could read it. Security
 * accepts that window; this line makes it visible. Names only: the path,
 * never what the file holds.
 *
 * A base counts only when it was named exactly at the last render too: a base
 * that kept its globs then covered every file in it, so nothing new was open.
 * The first render of a chat only remembers. Kept in memory for the most
 * recent {@link MAX_REMEMBERED_CHATS} chats; a restart starts each one fresh.
 *
 * @module services/runtimes/codex/policy/secret-file-activity
 */
import type { ActivityService } from '../../../activity/activity-service.js';

/** How many chats' last renders are remembered. */
export const MAX_REMEMBERED_CHATS = 500;
/** The most paths one line carries. */
const MAX_LISTED_FILES = 20;

/** One line for the feed. */
export interface SecretFileActivityEntry {
  /** The DorkOS chat the profile was rendered for. */
  sessionId: string;
  /** The first new secret file, by path. */
  file: string;
  /** The sentence. */
  summary: string;
  /** Every new secret file, by path, at most {@link MAX_LISTED_FILES}. */
  files: string[];
}

type SecretFileActivityPort = (entry: SecretFileActivityEntry) => void;

let port: SecretFileActivityPort | undefined;
/** Per chat, per base: the exact keys of its last render. */
const lastRender = new Map<string, Map<string, ReadonlySet<string>>>();

/**
 * Hand the profile the Activity writer.
 *
 * @param next - The writer, or `undefined` to stop writing (tests).
 */
export function setSecretFileActivity(next: SecretFileActivityPort | undefined): void {
  port = next;
}

/**
 * Build the writer that records a new secret file in the Activity feed.
 *
 * @param activityService - The Activity feed writer.
 */
export function createSecretFileActivityWriter(
  activityService: ActivityService
): SecretFileActivityPort {
  return (entry) => {
    void activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'codex_secret_file.appeared',
      resourceType: 'file',
      resourceId: entry.file,
      summary: entry.summary,
      metadata: { sessionId: entry.sessionId, files: entry.files },
    });
  };
}

/** Forget every remembered render (tests). */
export function forgetSecretFileRenders(): void {
  lastRender.clear();
}

/**
 * Compare one render's exact secret rules with the chat's last render, and
 * write one line when a base named exactly both times gained a file.
 *
 * @param sessionId - The DorkOS chat.
 * @param exact - Each base named exactly in this render, with its keys.
 * @returns The new files, sorted; empty when there are none.
 */
export function noteRenderedSecrets(
  sessionId: string,
  exact: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const before = lastRender.get(sessionId);
  lastRender.delete(sessionId);
  lastRender.set(sessionId, new Map(exact));
  if (lastRender.size > MAX_REMEMBERED_CHATS) {
    lastRender.delete(lastRender.keys().next().value!);
  }
  if (before === undefined) return [];
  // A file inside two bases (the chat's folder under the home) is said once.
  const earlier = new Set<string>();
  for (const base of exact.keys()) for (const key of before.get(base) ?? []) earlier.add(key);
  const fresh = new Set<string>();
  for (const [base, keys] of exact) {
    if (!before.has(base)) continue;
    for (const key of keys) if (!earlier.has(key)) fresh.add(key);
  }
  const files = [...fresh].sort();
  if (files.length === 0) return files;
  port?.({
    sessionId,
    file: files[0]!,
    summary:
      files.length === 1
        ? `A secret file appeared after the last Codex turn started: ${files[0]}. It's protected now.`
        : `${files.length} secret files appeared after the last Codex turn started. They're protected now.`,
    files: files.slice(0, MAX_LISTED_FILES),
  });
  return files;
}
