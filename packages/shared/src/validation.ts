/**
 * Shared validation utilities for agent names and identifiers.
 *
 * @module shared/validation
 */

/**
 * Regex for valid agent names: kebab-case, 1-64 chars, starts with a letter.
 *
 * Rules:
 * - Lowercase letters, digits, and hyphens only
 * - Must start with a lowercase letter
 * - Must end with a lowercase letter or digit (unless single char)
 * - 1-64 characters
 * - Prevents path traversal (no `.`, `/`, `\`, `_`)
 */
export const AGENT_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/;

/**
 * Validate an agent name string and return a structured result.
 *
 * @param name - The candidate agent name to validate
 * @returns Object with `valid` boolean and optional `error` message
 */
export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name) return { valid: false, error: 'Name is required' };
  if (name.length > 64) return { valid: false, error: 'Name must be 64 characters or less' };
  if (!AGENT_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error: 'Lowercase letters, numbers, and hyphens only. Must start with a letter.',
    };
  }
  return { valid: true };
}

/**
 * Convert a freeform display name into a valid kebab-case agent slug.
 *
 * @param displayName - The human-readable name to slugify
 * @returns A string that passes {@link AGENT_NAME_REGEX}, or `'agent'` on empty input
 */
export function slugifyAgentName(displayName: string): string {
  let slug = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Must start with a letter
  if (slug && /^[0-9]/.test(slug)) slug = `a-${slug}`;

  // Enforce max length and trim any trailing hyphen from truncation
  slug = slug.slice(0, 64).replace(/-$/, '');

  return slug || 'agent';
}

/**
 * Resolve the display name for an agent, falling back through displayName → name → fallback.
 *
 * @param agent - Object with optional displayName and name fields (or null/undefined)
 * @param fallback - Fallback string when both fields are empty (default: `'Agent'`)
 */
export function getAgentDisplayName(
  agent: { displayName?: string | null; name?: string | null } | null | undefined,
  fallback = 'Agent'
): string {
  return agent?.displayName || agent?.name || fallback;
}
