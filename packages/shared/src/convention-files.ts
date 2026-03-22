/**
 * Convention file constants and pure helpers for SOUL.md and NOPE.md.
 *
 * Browser-safe — no Node.js imports. For filesystem operations
 * (read/write convention files), use `@dorkos/shared/convention-files-io`.
 *
 * @module shared/convention-files
 */

export const CONVENTION_FILES = {
  soul: 'SOUL.md',
  nope: 'NOPE.md',
} as const;

export const SOUL_MAX_CHARS = 4000;
export const NOPE_MAX_CHARS = 2000;

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
