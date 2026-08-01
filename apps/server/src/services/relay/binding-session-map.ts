/**
 * The router's persisted session map: how one entry is read off disk, and how
 * one is described back out.
 *
 * Split from `binding-router.ts` because neither half is about routing. Both
 * are about the shape of a file the router happens to own, and both carry a
 * correctness note that is easy to lose next to four hundred lines of dispatch
 * logic — a legacy on-disk shape that must keep parsing, and a key whose middle
 * segment must not be guessed at.
 *
 * @module services/relay/binding-session-map
 */
import type { BindingSessionEntry } from './binding-router.js';

/** What the router remembers about one session. */
export interface SessionRecord {
  sessionId: string;
  /** Epoch ms of the last message routed through it; 0 when never observed. */
  lastActivityAt: number;
}

/**
 * Read one persisted session entry, in either shape it can be on disk.
 *
 * The file used to hold `[key, sessionId]` pairs and now holds
 * `[key, {sessionId, lastActivityAt}]`. A file written by an older build is
 * read, not discarded: its sessions are real, they simply have no recorded
 * activity yet, which is exactly what `lastActivityAt: 0` says.
 *
 * @param entry - One parsed JSON array element.
 * @returns The key/record pair, or `null` when the entry is malformed.
 */
export function parseSessionEntry(entry: unknown): [string, SessionRecord] | null {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
  const [key, value] = entry as [string, unknown];

  if (typeof value === 'string') return [key, { sessionId: value, lastActivityAt: 0 }];

  if (value !== null && typeof value === 'object') {
    const { sessionId, lastActivityAt } = value as Record<string, unknown>;
    if (typeof sessionId !== 'string') return null;
    return [
      key,
      {
        sessionId,
        lastActivityAt: typeof lastActivityAt === 'number' ? lastActivityAt : 0,
      },
    ];
  }

  return null;
}

/**
 * Describe one session-map entry without guessing what its key means.
 *
 * The key is `bindingId:(chat|user):id`, and the middle segment is the whole
 * point: read blindly, a per-user session's person id was reported as a chat id
 * and messages addressed to it went to the wrong conversation.
 *
 * @param key - The session-map key.
 * @param record - What the router remembers about that session.
 */
export function describeSession(key: string, record: SessionRecord): BindingSessionEntry {
  const parts = key.split(':');
  const scope = parts[1] === 'user' ? 'user' : 'chat';
  // Ids can contain colons (Slack thread keys do), so the tail is rejoined.
  const id = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
  return {
    key,
    scope,
    ...(scope === 'user' ? { userId: id } : { chatId: id }),
    sessionId: record.sessionId,
    lastActivityAt: record.lastActivityAt,
  };
}
