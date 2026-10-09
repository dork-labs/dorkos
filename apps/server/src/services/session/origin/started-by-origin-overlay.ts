import type { Session, SessionStartedBy } from '@dorkos/shared/types';
import type { StartedByRecord } from './session-started-by-store.js';

/**
 * Batched lookup of who started these chats, injected from the composition
 * root: the stored rows, by id. Chats nobody started are absent.
 */
export type ResolveStartedBy = (sessionIds: string[]) => Map<string, StartedByRecord>;

/** An extension's manifest name, or its id when it is no longer installed. */
export type ExtensionNameOf = (extensionId: string) => string;

/** How many chat titles {@link rememberTitle} keeps for "Started from <title>". */
const TITLE_MEMORY = 2_000;

/**
 * Titles of chats this process has listed, newest last, so a chat started from
 * another can name it without a runtime read: the overlays are synchronous, and
 * the parent is almost always a chat the app listed moments earlier. A title it
 * does not know reads as null, which the app words as "another chat".
 */
const knownTitles = new Map<string, string>();

/**
 * A chat's title as this process last listed it, or null when it has not
 * listed that chat (or the chat has no title).
 *
 * @param sessionId - The chat.
 */
export function rememberedChatTitle(sessionId: string): string | null {
  return knownTitles.get(sessionId) ?? null;
}

function rememberTitle(session: Session): void {
  if (!session.title) return;
  knownTitles.delete(session.id);
  knownTitles.set(session.id, session.title);
  if (knownTitles.size > TITLE_MEMORY) {
    const oldest = knownTitles.keys().next().value;
    if (oldest !== undefined) knownTitles.delete(oldest);
  }
}

/**
 * The wire shape of one stored start.
 *
 * @param record - The stored row.
 * @param nameOf - An extension's name.
 * @param titleOf - A chat's title, or null.
 */
export function toStartedBy(
  record: StartedByRecord,
  nameOf: ExtensionNameOf,
  titleOf: (sessionId: string) => string | null
): SessionStartedBy | null {
  if (record.kind === 'extension') {
    if (!record.extensionId) return null;
    return {
      kind: 'extension',
      extensionId: record.extensionId,
      extensionName: nameOf(record.extensionId),
      reason: record.reason ?? '',
    };
  }
  if (!record.startedBySessionId) return null;
  return {
    kind: 'chat',
    sessionId: record.startedBySessionId,
    title: titleOf(record.startedBySessionId),
    reason: record.reason,
    permission: record.permissionMode
      ? {
          mode: record.permissionMode,
          // Decided at the start by declared level, never by comparing ids
          // here: `acceptEdits` and `auto` are one level under two ids.
          sameAsStarter: record.permissionSameAsStarter === true,
        }
      : null,
  };
}

/**
 * Overlay `startedBy` onto listed sessions, in place (spec `flow-multiproject`
 * §7.7, D13). The third origin step, after room and task: it sets its own field
 * and never touches `origin`, `originLabel` or `userLastMessageAt`, so it
 * cannot undo what the two before it decided. A no-op when `resolveStartedBy`
 * is undefined (no database).
 *
 * @param sessions - The rows to mark, mutated in place.
 * @param resolveStartedBy - The batched lookup.
 * @param nameOf - An extension's manifest name.
 */
export function applyStartedByOverlay(
  sessions: Session[],
  resolveStartedBy: ResolveStartedBy | undefined,
  nameOf: ExtensionNameOf | undefined
): void {
  if (sessions.length === 0) return;
  for (const session of sessions) rememberTitle(session);
  if (!resolveStartedBy) return;
  const starts = resolveStartedBy(sessions.map((s) => s.id));
  if (starts.size === 0) return;
  const titleOf = (id: string) => knownTitles.get(id) ?? null;
  for (const session of sessions) {
    const record = starts.get(session.id);
    if (!record) continue;
    const startedBy = toStartedBy(record, nameOf ?? ((id) => id), titleOf);
    if (!startedBy) continue;
    session.startedBy = startedBy;
  }
}

/**
 * Forget every remembered chat title (tests).
 *
 * @internal
 */
export function _forgetTitles(): void {
  knownTitles.clear();
}
