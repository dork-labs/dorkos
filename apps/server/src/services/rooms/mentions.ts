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
 * The same handle shape as {@link MENTION_PATTERN}, anchored — "is this string
 * addressable *whole*", rather than "find the addressable part of it".
 *
 * Two literals rather than one constructed regex, because both are read far more
 * often than they are changed and `new RegExp` obscures either. A test pins them
 * in step over a table of names, which is the guarantee that matters: a picker
 * offering a handle this accepts but `MENTION_PATTERN` truncates would insert a
 * mention that silently reaches nobody.
 */
const WHOLE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Trailing punctuation to shave off a match, so `@ana.` and `@ana,` resolve.
 * A trailing `.` or `-` is far more often a sentence than part of a handle.
 */
const TRAILING_PUNCTUATION = /[.\-_]+$/;

/**
 * Who owns each name in a roster: lowercased name to author id, first claimant
 * wins.
 *
 * **The one place the ownership rule lives.** Both halves of the mention
 * contract read it — {@link resolveMentions} to decide who an `@name` reaches,
 * and {@link advertisedHandle} to decide what a picker may offer. Deriving
 * "who owns this name" a second time is how a picker starts offering a handle
 * that addresses somebody else.
 *
 * @param roster - The room's members and the names each answers to, in the
 *   order that decides ties.
 */
export function claimNames(roster: readonly MentionCandidate[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const candidate of roster) {
    for (const name of candidate.names) {
      const key = name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, candidate.authorId);
    }
  }
  return byName;
}

/**
 * The handle to offer for one member: the first name it can be typed by **and**
 * actually owns.
 *
 * Two conditions, and both are load-bearing.
 *
 * *Typeable* rules out a name with a space in it: `@Mio Clicker PM` matches only
 * `@Mio`, which resolves to nobody and posts as plain text.
 *
 * *Owned* rules out a name an earlier member claimed — including one that
 * member never advertised. A member whose handle is unusable falls back to its
 * display name, and if an earlier member already answers to that display name,
 * offering it would address the earlier member instead. That is worse than
 * inert: a mention **addresses** an agent, so the wrong one answers and the
 * intended one stays silent, which from inside the room is indistinguishable
 * from a broken agent (`meta/agent-etiquette.md` E1).
 *
 * `undefined` means no string reaches this member, which is the honest answer —
 * nothing here can invent one.
 *
 * @param candidate - The member and the names it answers to, most preferred first.
 * @param claims - Ownership over the whole roster, from {@link claimNames}.
 * @returns The handle to insert after an `@`, or `undefined` when there is none.
 */
export function advertisedHandle(
  candidate: MentionCandidate,
  claims: ReadonlyMap<string, string>
): string | undefined {
  for (const name of candidate.names) {
    const trimmed = name.trim();
    if (!WHOLE_HANDLE.test(trimmed)) continue;
    if (claims.get(trimmed.toLowerCase()) === candidate.authorId) return trimmed;
  }
  return undefined;
}

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
  const byName = claimNames(roster);

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
