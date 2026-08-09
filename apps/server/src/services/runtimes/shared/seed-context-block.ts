/**
 * The `<seed_context>` body every runtime renders.
 *
 * ## Why this is shared rather than per-adapter
 *
 * ADR-0273 splits the work: the server owns WHAT context exists, each adapter
 * owns HOW it is rendered. For `git_status` that split is free — three adapters
 * formatting a branch name differently costs nothing. For a seed it is not,
 * twice over.
 *
 * A seed is PROSE. Somebody wrote a paragraph for a model to read. The Codex and
 * OpenCode adapters render every other kind as `JSON.stringify(data, null, 2)`,
 * which turns that paragraph into one quoted line with `\n` spelled out inside
 * it — the same words, delivered badly, on two runtimes out of three.
 *
 * And a seed is INVISIBLE. Nothing in the transcript shows it, so the only place
 * the reader can be told is the block itself. That sentence is the honesty seam
 * for the whole feature, and a sentence written three times is one that holds in
 * one place and drifts in the other two. So it is written once, here, and all
 * three adapters call it — exactly as they do for `room_context`, for the same
 * kind of reason.
 *
 * ## What the framing has to say, and why each line is there
 *
 * **Who wrote it.** Not the person in the conversation. An agent that reads a
 * seed as the person's own instruction will act on something nobody in the room
 * asked for.
 *
 * **That the person cannot see it.** This is the one that changes behavior. An
 * agent that answers "as you mentioned, you're on the Marketplace page" is
 * quoting words the person never wrote and cannot find, which reads as the agent
 * inventing history. Knowing the seed is invisible is what lets it use the
 * background without referring to it.
 *
 * **That it is background, not a task.** A seed describes a situation; the
 * person's message is the request. Without this an agent handed "they arrived
 * from the docs page for marketplace sources" tends to start explaining
 * marketplace sources.
 *
 * ## Why the text is defused, even though it is not a room
 *
 * The text is NOT wrapped in a nonced untrusted fence the way a room's messages
 * are: a room carries words other people typed into a shared space, while a seed
 * comes from whoever is already driving this session — the same caller that
 * supplied `content`, with no more authority than it.
 *
 * But no fence means `defuseSystemTags` is the ONLY boundary here, not defence
 * in depth, and rendering the text raw was a real hole rather than a theoretical
 * one. A seed containing `</seed_context>` closes the block, and everything
 * after it is loose in the prompt — free to open a syntactically perfect
 * `<git_status>` of its own, which the render strip then removes from the
 * transcript along with the real one. The person reads back a conversation with
 * no trace that any of it happened. That is precisely the promise this feature
 * makes ("your transcript shows only the words you wrote"), broken by the
 * feature itself, so the tags are defused and the escaped form (`&lt;/…`) is
 * what a reader sees.
 *
 * @module server/services/runtimes/shared/seed-context-block
 */
import type { SeedContextData } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { defuseSystemTags } from '@dorkos/shared/untrusted-text';

/**
 * The standing framing above every seed. Fixed prose rather than a template:
 * there is nothing per-call in it, and a constant is what makes it one sentence
 * to change rather than three.
 */
const SEED_PREAMBLE = [
  'Background attached by whoever opened this conversation — not typed by the person you are talking to.',
  'They cannot see this block, so never quote it back or refer to it as something they said.',
  'It describes the situation; their message is the request.',
].join('\n');

/** Tags that mean something to a runtime and must not survive in a seed. */
const SYSTEM_TAGS = [...Object.values(CONTEXT_TAG), 'system-reminder'];

/**
 * Render the body of a `<seed_context>` block: the standing framing, then the
 * caller's text with runtime tags defused.
 *
 * Everything that is a seed's WORDS survives — `defuseSystemTags` escapes only
 * the `<` of a runtime tag opening, so prose, code, `Vec<T>` and `a < b` all
 * come through as written. What cannot survive is a spelling of a system tag
 * that a parser would act on; see the module doc for what that bought.
 *
 * The length bound is enforced upstream, at the assembler
 * (`services/session/context-assembler.ts`), because that is the one place BOTH
 * transports pass through — the HTTP route refuses an over-length seed outright,
 * and the embedded path has no such boundary to refuse at.
 *
 * @param data - The seed's text.
 * @returns The block body the adapter wraps in `CONTEXT_TAG.seed_context`.
 */
export function formatSeedContext(data: SeedContextData): string {
  return `${SEED_PREAMBLE}\n\n${defuseSystemTags(data.text, SYSTEM_TAGS)}`;
}
