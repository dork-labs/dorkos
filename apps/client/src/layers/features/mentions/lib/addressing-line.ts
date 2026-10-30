/**
 * The quiet line under a channel's composer that says who a draft asks and
 * who it only copies in (DOR-3401): "Asks @ana · cc @bo, @kai".
 *
 * The rule itself is `@dorkos/shared/mention-addressing`, the same one the
 * server applies when the message is written. This only finds the `@handle`s
 * in the draft so the rule has spans to read. It is a preview: the server
 * resolves the sent message on its own and never reads this.
 *
 * @module features/mentions/lib/addressing-line
 */
import type { AuthorRef } from '@dorkos/shared/room-schemas';
import { markCc, type AddressableSpan } from '@dorkos/shared/mention-addressing';

/** The server's handle grammar (`services/rooms/mentions.ts`). */
const HANDLE = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/** A trailing `.`, `-` or `_` is a sentence, not part of the handle. */
const TRAILING = /[.\-_]+$/;

/**
 * Find the `@handle`s in a draft that name a member of this room.
 *
 * @param text - The draft.
 * @param members - The room's roster.
 */
function draftSpans(
  text: string,
  members: readonly { author: AuthorRef }[]
): (AddressableSpan & { handle: string })[] {
  const byHandle = new Map<string, string>();
  for (const { author } of members) {
    if (author.handle) byHandle.set(author.handle.toLowerCase(), author.handle);
  }
  const spans: (AddressableSpan & { handle: string })[] = [];
  for (const match of text.matchAll(HANDLE)) {
    if (match.index === undefined) continue;
    const raw = match[1]!.toLowerCase();
    const bare = raw.replace(TRAILING, '');
    const handle = byHandle.get(raw) ?? byHandle.get(bare);
    if (!handle) continue;
    const length = (byHandle.has(raw) ? raw.length : bare.length) + 1;
    spans.push({ offset: match.index, length, authorId: handle, handle });
  }
  return spans;
}

/**
 * The line to show under the composer, or `null` while the draft has no cc.
 *
 * @param text - The draft as typed.
 * @param members - The room's roster.
 * @returns "Asks @a · cc @b, @c", or `null` when there is nothing to say.
 */
export function addressingLine(
  text: string,
  members: readonly { author: AuthorRef }[]
): string | null {
  const marked = markCc(text, draftSpans(text, members));
  const asks: string[] = [];
  const cc: string[] = [];
  for (const span of marked) {
    const list = span.cc ? cc : asks;
    if (!list.includes(span.handle)) list.push(span.handle);
  }
  if (cc.length === 0 || asks.length === 0) return null;
  const names = (handles: string[]) => handles.map((handle) => `@${handle}`).join(', ');
  return `Asks ${names(asks)} · cc ${names(cc)}`;
}
