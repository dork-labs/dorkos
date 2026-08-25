/**
 * Convention file constants and pure helpers for SOUL.md, NOPE.md and MEMORY.md.
 *
 * Browser-safe — no Node.js imports. For filesystem operations
 * (read/write convention files), use `@dorkos/shared/convention-files-io`.
 *
 * @module shared/convention-files
 */

export const CONVENTION_FILES = {
  soul: 'SOUL.md',
  nope: 'NOPE.md',
  memory: 'MEMORY.md',
} as const;

/**
 * The name of any convention file, derived from {@link CONVENTION_FILES}.
 *
 * Derived rather than written out, because the same union used to be declared
 * by hand on both the reader and the writer in `convention-files-io`: widening
 * one and forgetting the other compiles on the read path and fails only
 * wherever the writer is called. One source, both signatures.
 */
export type ConventionFileName = (typeof CONVENTION_FILES)[keyof typeof CONVENTION_FILES];

export const SOUL_MAX_CHARS = 4000;
export const NOPE_MAX_CHARS = 2000;

/**
 * How much memory one agent may keep, in characters (~2K tokens).
 *
 * The cap is not storage thrift — a markdown file could be a megabyte and
 * nobody would notice on disk. It is a **prompt** budget, and it is the reason
 * the worst case of agent memory is knowable. On claude-code the memory block
 * rides the cached system prompt, so it costs this much once per cache
 * lifetime; on codex and opencode the agent-context append is re-sent verbatim
 * on every single turn, uncached, so a full memory file is roughly 10 KB per
 * turn, every turn, forever. An uncapped file would make that unbounded on two
 * of three runtimes.
 *
 * **It lives here, in the browser-safe module, and `@dorkos/memory` re-exports
 * it.** The number is enforced in three places that must agree — the engine's
 * write refusal, `UpdateAgentConventionsSchema`'s wire cap, and the editor's
 * character counter — and the third of those runs in a browser. Owning it in
 * the engine would either drag `node:fs` into the client bundle or duplicate
 * the number into a second constant nobody updates twice.
 *
 * **The unit is UTF-16 code units** — JavaScript's `String.length`, not bytes
 * and not tokens — because that is what every surface enforcing it already
 * counts: the Zod `.max()`, the engine's comparison, and the editor's counter.
 * A character outside the Basic Multilingual Plane therefore spends two, and
 * every character spends at least as much as its token cost. The cap can only
 * ever over-charge against the prompt budget it is defending, never
 * under-charge, which is the direction a safety limit should round.
 *
 * Writes that would cross it are refused with an error that says how to fix it,
 * never trimmed silently. A file already over the cap — only reachable by
 * editing it on disk — still reads, truncated, with a visible warning.
 */
export const MEMORY_MAX_CHARS = 8_000;

/** Marker separating auto-generated traits from custom prose */
export const TRAIT_SECTION_START = '<!-- TRAITS:START -->';
export const TRAIT_SECTION_END = '<!-- TRAITS:END -->';

/**
 * Build a SOUL.md with auto-generated trait section + custom prose.
 * The trait section is delimited by HTML comments and auto-regenerated
 * on every slider change. Custom prose below is never touched.
 *
 * @param traitBlock - Rendered trait directives (from `renderTraits()`)
 * @param customProse - User-written prose (everything after the trait section)
 */
export function buildSoulContent(traitBlock: string, customProse: string): string {
  const parts = [TRAIT_SECTION_START, '## Personality Traits\n', traitBlock, TRAIT_SECTION_END];

  if (customProse.trim()) {
    parts.push('', customProse.trim());
  }

  return parts.join('\n');
}

/**
 * Extract the custom prose section from a SOUL.md file,
 * preserving everything after the TRAITS:END marker.
 *
 * @param soulContent - Full SOUL.md file content
 */
export function extractCustomProse(soulContent: string): string {
  const endIndex = soulContent.indexOf(TRAIT_SECTION_END);
  if (endIndex === -1) {
    // No trait section — entire content is custom prose
    return soulContent;
  }
  return soulContent.slice(endIndex + TRAIT_SECTION_END.length).trim();
}

/**
 * Default SOUL.md template for new agents.
 *
 * @param agentName - Agent display name for the identity section
 * @param traitBlock - Rendered trait directives (from `renderTraits()`)
 */
export function defaultSoulTemplate(agentName: string, traitBlock: string): string {
  const customProse = [
    '## Identity',
    '',
    `You are ${agentName}, a coding assistant.`,
    '',
    '## Values',
    '',
    '- Write clean, maintainable code',
    '- Respect existing patterns and conventions',
    '- Communicate clearly about trade-offs',
  ].join('\n');

  return buildSoulContent(traitBlock, customProse);
}

/**
 * Default NOPE.md template for new agents.
 */
export function defaultNopeTemplate(): string {
  return [
    '# Safety Boundaries',
    '',
    '## Never Do',
    '',
    '- Never push to main/master without explicit approval',
    '- Never delete production data or databases',
    '- Never commit secrets, API keys, or credentials',
    '- Never run destructive commands (rm -rf, DROP TABLE) without confirmation',
    '- Never modify CI/CD pipelines without review',
    '',
    '## Always Do',
    '',
    '- Always create a new branch for changes',
    '- Always run tests before committing',
    '- Always preserve existing functionality when refactoring',
  ].join('\n');
}
