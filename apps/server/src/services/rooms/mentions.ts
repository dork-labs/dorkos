/**
 * Resolve `@name` to author ids at write time (spec `rooms` §5).
 *
 * Resolution happens **once**, when the entry is written, and the resolved list
 * is stored on the entry. The client renders from that list and never re-parses
 * the text — so renaming an agent tomorrow cannot silently re-address a message
 * sent today, and a room member cannot be added to a conversation retroactively
 * by an edit to their own name.
 *
 * An unresolvable `@name` stays plain text. It is not an error, it is somebody
 * writing an email address or a price.
 *
 * Pure — the caller supplies the roster.
 *
 * @module server/services/rooms/mentions
 */

/**
 * One roster member as mention resolution sees it. `names` is tried in order,
 * so put the agent's handle (`name`) before its `displayName`: the handle is
 * what someone types after an `@`, and the display name is the fallback.
 */
export interface MentionCandidate {
  authorId: string;
  names: readonly string[];
}

/**
 * Matches an `@handle`: a letter or digit, then letters, digits, `_`, `.`, `-`.
 *
 * Deliberately excludes whitespace, so a display name with a space in it is not
 * addressable by `@`. Spanning a space would make `@Ana and Bo` ambiguous
 * between one member and two, and no chat product resolves that well without an
 * autocomplete that writes a delimiter. Agent handles are already slugs.
 */
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/**
 * Trailing punctuation to shave off a match, so `@ana.` and `@ana,` resolve.
 * A trailing `.` or `-` is far more often a sentence than part of a handle.
 */
const TRAILING_PUNCTUATION = /[.\-_]+$/;

/**
 * Resolve every `@name` in `text` against a room's roster.
 *
 * Matching is case-insensitive. The first roster member claiming a name wins,
 * so a handle collision resolves deterministically rather than by scan order at
 * the call site.
 *
 * @param text - The raw message body.
 * @param roster - The room's members and the names each answers to.
 * @returns Distinct author ids, in the order they were first mentioned.
 */
export function resolveMentions(text: string, roster: readonly MentionCandidate[]): string[] {
  const byName = new Map<string, string>();
  for (const candidate of roster) {
    for (const name of candidate.names) {
      const key = name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, candidate.authorId);
    }
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[1].toLowerCase();
    const authorId = byName.get(raw) ?? byName.get(raw.replace(TRAILING_PUNCTUATION, ''));
    if (!authorId || seen.has(authorId)) continue;
    seen.add(authorId);
    resolved.push(authorId);
  }
  return resolved;
}
