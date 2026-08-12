/**
 * The `<staged_context>` body every runtime renders.
 *
 * ## Why this is shared rather than per-adapter
 *
 * ADR-0273 splits the work: the server owns WHAT context exists, each adapter
 * owns HOW it is rendered. For a staged note that split is not free, for the
 * same two reasons `seed-context-block.ts` is shared.
 *
 * A staged note is PROSE — a person wrote it for the model to read. Codex and
 * OpenCode render every structured kind as `JSON.stringify(data, null, 2)`,
 * which turns that prose into one quoted line with `\n` spelled out inside it.
 * So the body is written once here and all three adapters call it, exactly as
 * they do for `seed_context` and `room_context`.
 *
 * ## Why the text is defused
 *
 * This entry is ONLY produced on the fold-into-next fallback (a runtime that
 * cannot append to its own transcript natively), and its text is whatever the
 * person staged. With no nonced fence, `defuseSystemTags` is the only boundary:
 * a staged note containing `</staged_context>` would otherwise close the block
 * and leave the rest loose in the prompt, free to forge a `<git_status>` the
 * render strip then removes from the transcript along with the real one — the
 * same hole `seed-context-block.ts` documents. So runtime tags are defused and
 * the escaped form (`&lt;/…`) is what a reader sees.
 *
 * ## What the framing says
 *
 * It is material the person attached ahead of their message, to work with — not
 * a fresh instruction they just typed. Without that, an agent handed a staged
 * note tends to treat it as the request and act on it directly, ahead of the
 * message it was meant to inform.
 *
 * @module server/services/runtimes/shared/staged-context-block
 */
import type { StagedContextData } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { defuseSystemTags } from '@dorkos/shared/untrusted-text';

/**
 * The standing framing above every staged note. Fixed prose rather than a
 * template: nothing in it is per-call, so a constant makes it one sentence to
 * change rather than three.
 */
const STAGED_PREAMBLE = [
  'The person attached this ahead of their message — material to work with, not a new instruction they just typed.',
].join('\n');

/** Tags that mean something to a runtime and must not survive in a staged note. */
const SYSTEM_TAGS = [...Object.values(CONTEXT_TAG), 'system-reminder'];

/**
 * Render the body of a `<staged_context>` block: the standing framing, then the
 * person's text with runtime tags defused.
 *
 * Everything that is the note's WORDS survives — `defuseSystemTags` escapes only
 * the `<` of a runtime tag opening — while a spelling of a system tag a parser
 * would act on does not; see the module doc for what that bought.
 *
 * @param data - The staged text.
 * @returns The block body the adapter wraps in `CONTEXT_TAG.staged_context`.
 */
export function formatStagedContext(data: StagedContextData): string {
  return `${STAGED_PREAMBLE}\n\n${defuseSystemTags(data.text, SYSTEM_TAGS)}`;
}
