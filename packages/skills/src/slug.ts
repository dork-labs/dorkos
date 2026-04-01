/**
 * Validate a string against SKILL.md naming rules.
 *
 * Rules: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing
 * hyphens, no consecutive hyphens.
 *
 * @param s - The string to validate
 * @returns True if valid as a SKILL.md name
 */
export function validateSlug(s: string): boolean {
  if (s.length < 1 || s.length > 64) return false;
  if (s.includes('--')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
}

/**
 * Convert a display name to a valid SKILL.md slug.
 *
 * @param displayName - Human-readable name (e.g., "Daily Health Check")
 * @returns Kebab-case slug (e.g., "daily-health-check")
 */
export function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert a kebab-case slug to a human-readable title.
 *
 * @param slug - Kebab-case identifier (e.g., "daily-health-check")
 * @returns Title-cased string (e.g., "Daily Health Check")
 */
export function humanize(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
