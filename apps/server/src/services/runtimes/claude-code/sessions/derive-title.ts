import { TRANSCRIPT } from '../../../../config/constants.js';

/**
 * Leading request-filler phrases that carry no information in a session title.
 * Matched case-insensitively, repeatedly, at the start of the message only —
 * "Please can you fix the build" derives to "Fix the build".
 *
 * Deliberately excludes greetings (hey/hi/hello): stripping them mangles real
 * content like "Hello world program in Rust".
 */
const COURTESY_PREFIXES =
  /^(?:please|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|let's|lets|help me)[,!.\s]+/i;

/** Word budget for a derived title — matches the sidebar row grammar's target. */
const MAX_WORDS = 6;

/**
 * Derive a short session title from the first user message.
 *
 * Used only when the SDK has not produced a title of its own (the SDK's
 * auto-generated summaries are authoritative and not controllable from
 * DorkOS — see DOR-1055). Takes the first line, strips leading courtesy
 * phrases, and cuts at a word boundary within both a word budget and
 * {@link TRANSCRIPT.TITLE_MAX_LENGTH} characters, so "Please can you review
 * the help and feedback submission options on the settings page" derives to
 * "Review the help and feedback submission…" instead of an 80-char slice.
 *
 * @param firstUserMessage - The cleaned first user message text (may be empty)
 * @returns The derived title, or `''` when the message is empty/whitespace
 */
export function deriveSessionTitle(firstUserMessage: string): string {
  const firstLine = firstUserMessage.trim().split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return '';

  let base = firstLine;
  // Strip stacked courtesy openers ("Hey, please can you …"), but never strip
  // the whole message down to nothing.
  for (;;) {
    const stripped = base.replace(COURTESY_PREFIXES, '');
    if (stripped === base || stripped.trim() === '') break;
    base = stripped.trim();
  }

  const words = base.split(/\s+/);
  const budgeted = words.slice(0, MAX_WORDS).join(' ');
  const capped =
    budgeted.length > TRANSCRIPT.TITLE_MAX_LENGTH
      ? budgeted.slice(0, TRANSCRIPT.TITLE_MAX_LENGTH).replace(/\s+\S*$/, '')
      : budgeted;

  const truncated = capped.length < base.length;
  // Capitalize the first letter so "fix the build" reads as a title.
  const titled = capped.charAt(0).toUpperCase() + capped.slice(1);
  return truncated ? `${titled}…` : titled;
}
