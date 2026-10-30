/**
 * The quiet lines that say who a channel message wakes and who it only copies
 * in: under the composer while a draft has a cc ("Wakes @ana · cc @bo"), and
 * under the author's own post once it is sent ("Woke @ana. Cc: @bo.").
 *
 * The rule itself is `@dorkos/shared/mention-addressing`, the same one the
 * server applies when the message is written. The draft line only finds the
 * `@handle`s so the rule has spans to read. It is a preview: the server
 * resolves the sent message on its own and never reads this.
 *
 * @module features/mentions/lib/addressing-line
 */
import type { AuthorRef } from '@dorkos/shared/room-schemas';
import {
  ccAuthors,
  markCc,
  reachLine,
  type AddressableSpan,
} from '@dorkos/shared/mention-addressing';

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
 * @returns "Wakes @a · cc @b, @c", or `null` when there is nothing to say.
 */
export function addressingLine(
  text: string,
  members: readonly { author: AuthorRef }[]
): string | null {
  const marked = markCc(text, draftSpans(text, members));
  const wakes: string[] = [];
  const cc: string[] = [];
  for (const span of marked) {
    const list = span.cc ? cc : wakes;
    if (!list.includes(span.handle)) list.push(span.handle);
  }
  if (cc.length === 0) return null;
  const names = (handles: string[]) => handles.map((handle) => `@${handle}`).join(', ');
  return `${wakes.length > 0 ? `Wakes ${names(wakes)}` : 'Wakes nobody'} · cc ${names(cc)}`;
}

/**
 * Who a posted channel message reached, for the line under its author's own
 * post (DOR-3454): "Woke @ana. Cc: @bo." Read from the marks the server stored,
 * never from the text.
 *
 * @param entry - The posted entry's resolved mentions and their spans.
 * @param authors - The room's roster, keyed by author id.
 * @returns The line, or `null` for a post that names nobody but its author.
 */
export function postedReachLine(
  entry: {
    authorId: string;
    mentions: readonly string[];
    mentionSpans?: readonly (AddressableSpan & { cc?: boolean })[];
  },
  authors: ReadonlyMap<string, Pick<AuthorRef, 'kind' | 'handle' | 'displayName'>>
): string | null {
  const named = entry.mentions.filter((id) => id !== entry.authorId);
  if (named.length === 0) return null;
  const cc = new Set(ccAuthors(entry.mentionSpans ?? []));
  const label = (id: string) => `@${authors.get(id)?.handle ?? authors.get(id)?.displayName ?? id}`;
  // Only an agent wakes: a person named is told, and takes no turn.
  const woke = named.filter((id) => !cc.has(id) && authors.get(id)?.kind === 'agent');
  return reachLine(woke.map(label), named.filter((id) => cc.has(id)).map(label));
}
