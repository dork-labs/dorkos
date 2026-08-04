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
import type { MentionSpan } from '@dorkos/shared/room-schemas';

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
 * Whitespace is excluded, so a name with a space in it is not addressable by `@`
 * at all — and that is a real cost, not a free simplification. `agents.name` is
 * `z.string().min(1)`, and 7 of the 40 agents registered on the install this was
 * written against have a space in theirs. {@link advertisedHandle} exists to say
 * so honestly rather than to hide it, and `specs/handles` removes the cost by
 * giving every author one typeable handle.
 *
 * Matching across a space is nonetheless possible, and one chat product does it:
 * Buzz sorts a channel's roster longest-first and accepts a known name as a
 * prefix when a word boundary follows, tested on `"hello @Will Pfleger!"` and on
 * `["Will", "Will Pfleger"]` resolving to the longer. It is declined here
 * because of what it costs: the set of resolvable strings becomes a function of
 * who is currently in the room, so `@Ana Reyes said so` reaches Ana until a
 * member called `Ana Reyes` joins and it starts reaching her instead. A grammar
 * that ends at the first space resolves the same way in every room, on every
 * day. (`specs/handles/02-specification.md` §9 keeps the algorithm on file in
 * case legacy `@Display Name` text ever needs a fallback.)
 *
 * Exported so that the guard on the room-context block can ask what a model
 * would read as a mention using THIS definition rather than a copy of it — a
 * copy could pass while the resolver disagreed, which is the whole failure this
 * grammar is being guarded against. Global, so read it with `matchAll` (which
 * clones it) rather than `test`/`exec` (which move its `lastIndex`).
 */
export const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

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
 *
 * **It is a fallback, and the order is the whole story.**
 * {@link resolveMentions} looks the exact token up FIRST, so this rescues
 * `@ana.` only while nobody is called `ana.` — and the moment somebody is, the
 * shave never runs and the sentence-ending mention silently changes hands. That
 * is why {@link advertisedHandle} refuses to offer a name ending in punctuation,
 * and why nothing DorkOS renders puts a handle next to a full stop.
 *
 * Exported so the test that pins the two halves of the contract in step can
 * derive "is this name its own token" from the rule itself rather than spelling
 * it a second time.
 */
export const TRAILING_PUNCTUATION = /[.\-_]+$/;

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
 * The handle to offer for one member: the first name it can be typed by, does
 * not end in punctuation, **and** actually owns.
 *
 * Three conditions, and every one of them is load-bearing.
 *
 * *Typeable* rules out a name with a space in it: `@Mio Clicker PM` matches only
 * `@Mio`, which resolves to nobody and posts as plain text.
 *
 * *Not punctuation-tailed* rules out `ana.`, `bo-` and `cy_`, which are legal
 * under {@link WHOLE_HANDLE} and which {@link resolveMentions} does resolve —
 * that is exactly the problem. The resolver tries the **exact** token before
 * shaving anything, so the moment a member called `ana` exists, `@ana.` at the
 * end of a sentence stops reaching `ana` and starts reaching `ana.`. Advertising
 * such a name hands one member a string that quietly takes another member's
 * ordinary sentence-ending mentions, and `agents.name` comes from a manifest
 * anybody can write. Withholding it costs its owner nothing they had: their
 * other names are still tried, and nobody could safely type this one anyway.
 *
 * *Owned* rules out a name an earlier member claimed — including one that
 * member never advertised. A member whose handle is unusable falls back to its
 * display name, and if an earlier member already answers to that display name,
 * offering it would address the earlier member instead. That is worse than
 * inert: a mention **addresses** an agent, so the wrong one answers and the
 * intended one stays silent, which from inside the room is indistinguishable
 * from a broken agent (`meta/agent-etiquette.md` E1).
 *
 * **What this does not fix, deliberately.** {@link claimNames} claims every
 * roster name whether or not it is ever advertised, so somebody writing
 * `thanks @ana.` in free text still reaches a member whose NAME is `ana.`. That
 * residual is inherent to permitting a name that ends in punctuation, and it is
 * not fixable here — only at the source, which is what `specs/handles` §1 does
 * by requiring a handle to start *and end* alphanumeric (Phase 2, `authors.handle`).
 * This function is the guard that stops DorkOS itself from putting such a string
 * in front of anybody in the meantime.
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
    if (TRAILING_PUNCTUATION.test(trimmed)) continue;
    if (claims.get(trimmed.toLowerCase()) === candidate.authorId) return trimmed;
  }
  return undefined;
}

/**
 * A fenced-code delimiter line: three or more backticks or tildes, indented no
 * more than three spaces (four would make it an indented code block instead).
 *
 * Captures the run itself, because a fence is closed only by one of **the same
 * character, at least as long** — CommonMark's rule, and the only thing that
 * makes a ```` ``` ```` inside a ```` ```` ```` block read as content rather
 * than as a terminator.
 */
const CODE_FENCE = /^ {0,3}((`{3,})|(~{3,}))/;

/** A quoted line: markdown's blockquote marker, indented no more than three. */
const BLOCKQUOTE = /^ {0,3}>/;

/** An inline code span: the shortest run of text between matching backticks. */
const INLINE_CODE = /`[^`]*`/g;

/**
 * A same-length MASK of a message, with everything the author was merely
 * QUOTING blanked to spaces rather than removed.
 *
 * Three things are blanked: CLOSED fenced code blocks, blockquote lines, and
 * inline code spans. Each is text the author reproduced rather than wrote, and
 * an `@name` inside one is a citation, not an address. Every other character is
 * kept verbatim, and every blanked region is replaced character-for-character
 * with spaces — so the result is **exactly as long as the input, index for
 * index**. That is the whole reason it masks instead of dropping: a match found
 * in the mask sits at the SAME offset in the raw body, which is what lets a
 * caller both resolve a mention and say where it is (`mentionSpans`). Blanked
 * regions hold no `@`, so masking yields the identical mention tokens, in the
 * identical order, that dropping the regions once did.
 *
 * **This is what keeps "mentions resolve once, at write time" true.** Without
 * it, quoting a message re-addressed everybody it named — so a room's own late
 * answer, which quotes the question it is answering, re-triggered the original
 * message's targets, and one observed entry stored a mention of the very agent
 * that wrote it, from nothing but the quote in its own prefix.
 *
 * **Closed regions, not a running toggle**, and the difference is a message that
 * silently reaches nobody. A toggle treats the first ``` as "everything after
 * this is code", so a single stray or unterminated fence — somebody pasting a
 * snippet and forgetting to close it, which is ordinary — swallowed every
 * mention in the rest of the message. An opener with no matching closer is not a
 * code block; it is a line that happens to start with backticks, and the text
 * after it is the author talking. Scanning for the CLOSER first also gets
 * nesting right for free: a shorter fence inside a longer one cannot close it,
 * so it stays content.
 *
 * Deliberately a filter over the raw text rather than a markdown parse. The
 * grammar it has to agree with is {@link MENTION_PATTERN}, which is three
 * character classes; pulling a parser in to decide which of them count would be
 * a second, richer model of the same message, and the two would drift. Two
 * constructs are knowingly left resolving, because both need that parser and
 * neither is a way to quote somebody's mentions by accident: a **four-space
 * indented code block**, and a **lazy blockquote continuation** (a wrapped quote
 * line written without its own `>`). Widening this is a markdown parser's job,
 * not a regex's.
 *
 * @param text - The raw message body.
 * @returns A string the same length as `text`, with every quoted region blanked
 *   to spaces and everything else left where it was.
 */
function speakingMask(text: string): string {
  const lines = text.split('\n');
  /** Lines inside a fence that actually closed, and the two delimiters. */
  const fenced = new Set<number>();
  for (let at = 0; at < lines.length; at += 1) {
    if (fenced.has(at)) continue;
    const opener = CODE_FENCE.exec(lines[at]);
    if (!opener) continue;
    const closedAt = closingFence(lines, at, opener[1]);
    // Unclosed: this opener is ordinary text, and so is everything after it.
    if (closedAt === -1) continue;
    for (let inside = at; inside <= closedAt; inside += 1) fenced.add(inside);
    at = closedAt;
  }

  const masked: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    // A blanked LINE stays its own length so the newline structure — and thus
    // every later offset — is untouched; a blanked inline SPAN stays its own
    // length for the same reason. Both were once collapsed (line dropped, span
    // shrunk to one space), which changed offsets and is exactly what a span
    // cannot tolerate.
    if (fenced.has(at) || BLOCKQUOTE.test(line)) {
      masked.push(' '.repeat(line.length));
      continue;
    }
    masked.push(line.replace(INLINE_CODE, (span) => ' '.repeat(span.length)));
  }
  return masked.join('\n');
}

/**
 * Where the fence opened at `from` is closed, or `-1` when nothing closes it.
 *
 * A closer must use the same character as its opener and be at least as long,
 * and — CommonMark again — carry no info string, so ```` ```js ```` opens but
 * never closes.
 *
 * @param lines - Every line of the message.
 * @param from - The index of the opening delimiter.
 * @param opener - The opening delimiter's run, e.g. ``` ``` ``` or `~~~~`.
 */
function closingFence(lines: readonly string[], from: number, opener: string): number {
  for (let at = from + 1; at < lines.length; at += 1) {
    const candidate = CODE_FENCE.exec(lines[at]);
    if (!candidate) continue;
    const run = candidate[1];
    if (run[0] !== opener[0] || run.length < opener.length) continue;
    if (lines[at].slice(lines[at].indexOf(run) + run.length).trim() !== '') continue;
    return at;
  }
  return -1;
}

/**
 * Resolve every `@name` in `text` against a room's roster.
 *
 * Matching is case-insensitive. The first roster member claiming a name wins,
 * so a handle collision resolves deterministically rather than by scan order at
 * the call site.
 *
 * **Quoted text does not address anybody.** Blockquote lines, fenced code blocks
 * and inline code spans are blanked before matching — see
 * {@link speakingMask}.
 *
 * @param text - The raw message body.
 * @param roster - The room's members and the names each answers to.
 * @returns Distinct author ids, in the order they were first mentioned.
 */
export function resolveMentions(text: string, roster: readonly MentionCandidate[]): string[] {
  return addressingIn(text, roster, []).mentions;
}

/** Who a message reached, and who it tried to reach and could not. */
export interface Addressing {
  /** Distinct author ids addressed, in the order they were first mentioned. */
  mentions: string[];
  /**
   * Distinct roster members a name in this message NAMED but could not reach,
   * because their author no longer speaks for its directory.
   *
   * Never overlaps {@link Addressing.mentions}: a token is only ever weighed
   * against this set once resolution against the live roster has missed, so a
   * ghost sharing a live member's display name costs that live member nothing.
   */
  unreachable: string[];
  /**
   * Every resolved `@mention`, in text order, located by its offset in the raw
   * body — the per-occurrence sibling of {@link Addressing.mentions}. One span
   * per written `@handle` (NOT deduped: `@ana @ana` is two spans, one deduped
   * id), emitted only for a token that reached a LIVE author. A quoted or
   * unreachable `@name` gets none, exactly as it contributes nothing to
   * `mentions`. This is what the client draws pills from; it never re-parses the
   * text (`.claude/rules/room-conduct.md`).
   */
  spans: MentionSpan[];
}

/**
 * Resolve a message against a roster that has ghosts in it, answering both
 * halves in ONE pass over the text.
 *
 * **A released name must not become a silent name.** Releasing a ghost's claims
 * is what lets a live room-mate be reached again — but it also means
 * `@ana are you there?` resolves to nobody, and a message that addresses nobody
 * triggers nobody and used to write nothing at all. From inside the room that is
 * indistinguishable from an agent ignoring you, which is the one failure this
 * domain is not allowed to have (`.claude/rules/room-conduct.md`). So the same
 * pass that finds who a message reached also reports who it plainly meant.
 *
 * One pass, one grammar, one ownership rule: the alternative — a second scan of
 * the text somewhere else — would be a second answer to "who does this name
 * address", and mentions resolve once, at write time.
 *
 * @param text - The raw message body.
 * @param roster - The room's live and unreachable candidates.
 */
export function resolveAddressing(
  text: string,
  roster: { live: readonly MentionCandidate[]; unreachable: readonly MentionCandidate[] }
): Addressing {
  return addressingIn(text, roster.live, roster.unreachable);
}

/**
 * The single resolution pass behind {@link resolveMentions} and
 * {@link resolveAddressing}.
 *
 * @param text - The raw message body.
 * @param live - Who a name may reach, in the order that decides ties.
 * @param unreachable - Who a name would have reached, consulted only for tokens
 *   the live roster did not claim.
 */
function addressingIn(
  text: string,
  live: readonly MentionCandidate[],
  unreachable: readonly MentionCandidate[]
): Addressing {
  const byName = claimNames(live);
  // Built only when there is something to build it from, so an ordinary room
  // pays nothing for a mechanism about a state it is not in.
  const byGhostName = unreachable.length > 0 ? claimNames(unreachable) : null;

  const mentions: string[] = [];
  const missed: string[] = [];
  const spans: MentionSpan[] = [];
  const seen = new Set<string>();
  for (const match of speakingMask(text).matchAll(MENTION_PATTERN)) {
    // `matchAll` over a global pattern always sets `index`; the guard is for the
    // type, which admits `undefined`, not for a case that occurs.
    if (match.index === undefined) continue;
    const raw = match[1].toLowerCase();
    const bare = raw.replace(TRAILING_PUNCTUATION, '');
    // Try the exact token before the shaved one, exactly as the mention set
    // does — and remember WHICH won, because the span covers the handle the
    // resolver actually used: the whole `@token` when the exact name owned it,
    // or just `@bare` when a trailing `.`/`-`/`_` was shaved off to resolve it.
    const exactId = byName.get(raw);
    const authorId = exactId ?? byName.get(bare);
    if (authorId) {
      const handleLength = exactId ? match[1].length : bare.length;
      // One span PER occurrence — a pill is drawn at every position, even a
      // repeat the deduped `mentions` set drops. `+ 1` for the `@` itself.
      spans.push({ offset: match.index, length: handleLength + 1, authorId });
      if (!seen.has(authorId)) {
        seen.add(authorId);
        mentions.push(authorId);
      }
      continue;
    }
    // Only now — a name a live member owns is that member's, and a ghost behind
    // it is not news to anybody. A ghost draws no pill, so it earns no span.
    const ghostId = byGhostName?.get(raw) ?? byGhostName?.get(bare);
    if (!ghostId || seen.has(ghostId)) continue;
    seen.add(ghostId);
    missed.push(ghostId);
  }
  return { mentions, unreachable: missed, spans };
}
