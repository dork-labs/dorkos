import { TRANSCRIPT } from '../../../config/constants.js';

/**
 * Leading request-filler phrases that carry no information in a session title.
 * Matched case-insensitively, repeatedly, at the start of a line — "Please can
 * you fix the build" derives to "Fix the build". Both straight and curly
 * apostrophes are accepted ("i'd" / "i’d").
 *
 * Deliberately excludes greetings (hey/hi/hello): stripping them mangles real
 * content like "Hello world program in Rust".
 */
const COURTESY_PREFIXES =
  /^(?:please|can you|could you|would you|will you|i want you to|i need you to|i['’]d like you to|let['’]?s|lets|help me)[,!.\s]+/i;

/**
 * A line consisting only of a courtesy phrase (plus optional punctuation) —
 * e.g. a message opening with "Please," on its own line. Such a line is
 * skipped in favor of the next content line.
 */
const PURE_COURTESY_LINE =
  /^(?:please|can you|could you|would you|will you|i want you to|i need you to|i['’]d like you to|let['’]?s|lets|help me)[,!.\s]*$/i;

/**
 * A leading `@handle` a room delivers at the very start of a message that
 * addressed this agent — `@meeting-notes please review…` — see
 * `packages/shared/src/handle.ts` for the full charset a handle allows.
 * Stripped before derivation, ONLY when the caller opts in via
 * {@link DeriveSessionTitleOptions.stripLeadingMention}, so the mention that
 * routed the message here never becomes the session's title; only one leading
 * mention is stripped, since the pattern is anchored and matches once.
 *
 * This pattern is syntactically indistinguishable from plenty of real,
 * non-mention content that also opens a line with `@word` — `@override this
 * method…`, `@media queries…`, `@ts-expect-error…`, `@import rules…`, `@echo
 * off…` all match it. A room mention and a doc-comment tag or a shell/CSS/TS
 * directive look identical from here; only the caller knows which one it has.
 * That is why this is opt-in rather than automatic (DOR-2083 review).
 */
const LEADING_MENTION = /^@[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?[,:]?\s+/i;

/** Options for {@link deriveSessionTitle}. */
export interface DeriveSessionTitleOptions {
  /**
   * Strip a leading room `@mention` before deriving. Pass this ONLY when the
   * caller positively knows the message is a room turn that opened with a
   * mention — e.g. a room-bound trigger that read the addressing off the room
   * entry itself, never a generic first-message reading. No caller in this
   * repo has that knowledge at the point it calls this function today (the
   * claude-code transcript reader derives a title before a session's `room`
   * origin is known — that overlay runs later, on the aggregated list — and
   * the codex/opencode/test-mode registries have no room concept at all), so
   * this defaults to `false` and nothing currently opts in. A future caller
   * that CAN prove room-turn origin should pass `true`; everyone else must
   * leave real `@override`/`@media`/`@ts-expect-error`/`@import`/`@echo`
   * content alone.
   */
  stripLeadingMention?: boolean;
}

/** Word budget for a derived title — matches the sidebar row grammar's target. */
const MAX_WORDS = 6;

/** Strip stacked courtesy openers, never below one word. */
function stripCourtesy(line: string): string {
  let base = line;
  for (;;) {
    const stripped = base.replace(COURTESY_PREFIXES, '');
    if (stripped === base || stripped.trim() === '') break;
    base = stripped.trim();
  }
  return base;
}

/** Codepoint-safe cap that never splits a surrogate pair or a word. */
function capCodepoints(text: string, max: number): string {
  const codepoints = [...text];
  if (codepoints.length <= max) return text;
  const sliced = codepoints.slice(0, max).join('');
  const wordSafe = sliced.replace(/\s+\S*$/, '');
  return wordSafe === '' ? sliced : wordSafe;
}

/** Uppercase the first codepoint without splitting surrogate pairs. */
function capitalizeFirst(text: string): string {
  const [first, ...rest] = [...text];
  return first === undefined ? text : first.toUpperCase() + rest.join('');
}

/**
 * Derive a short session title from the first user message.
 *
 * Shared across every runtime's fallback-title path so the app titles
 * sessions one way (DOR-1055). SDK/runtime-generated titles stay
 * authoritative — this runs only when no real title exists. Behavior: a
 * leading room `@mention` is stripped first, but ONLY when
 * `options.stripLeadingMention` is `true` (see its TSDoc — the pattern also
 * matches real content like `@override`/`@media`/`@ts-expect-error`, so
 * stripping it is never safe as a default); then the first content line wins
 * (a line that is only "Please," defers to the next line), stacked courtesy
 * openers are stripped, the result is cut at a word boundary within a
 * {@link MAX_WORDS}-word budget and {@link TRANSCRIPT.TITLE_MAX_LENGTH}
 * codepoints, capitalized, and marked with an ellipsis only when words were
 * actually dropped from that line.
 *
 * @param firstUserMessage - The cleaned first user message text (may be empty)
 * @param options - See {@link DeriveSessionTitleOptions}.
 * @returns The derived title, or `''` when the message is empty/whitespace
 */
export function deriveSessionTitle(
  firstUserMessage: string,
  options?: DeriveSessionTitleOptions
): string {
  const source = options?.stripLeadingMention
    ? firstUserMessage.replace(LEADING_MENTION, '')
    : firstUserMessage;
  const lines = source.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || PURE_COURTESY_LINE.test(line)) continue;

    const base = stripCourtesy(line);
    const words = base.split(/\s+/);
    // Whitespace-normalized reference, so odd spacing alone never reads as
    // truncation (the reviewer's double-space defect).
    const normalized = words.join(' ');
    const budgeted = words.slice(0, MAX_WORDS).join(' ');
    const capped = capCodepoints(budgeted, TRANSCRIPT.TITLE_MAX_LENGTH);
    const truncated = capped.length < normalized.length;
    const titled = capitalizeFirst(capped);
    return truncated ? `${titled}…` : titled;
  }

  // The whole message was empty or pure courtesy — fall back to the first
  // non-empty line verbatim (within budget) rather than returning nothing.
  const fallback = lines.map((l) => l.trim()).find((l) => l !== '') ?? '';
  if (fallback === '') return '';
  const fallbackWords = fallback.split(/\s+/).slice(0, MAX_WORDS).join(' ');
  return capitalizeFirst(capCodepoints(fallbackWords, TRANSCRIPT.TITLE_MAX_LENGTH));
}
