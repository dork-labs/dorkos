/**
 * Normalize a section title into a URL-safe anchor ID.
 *
 * Handles em-dashes, ampersands, and other special characters that the
 * previous naive `title.toLowerCase().replace(/\s+/g, '-')` missed.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u2014/g, '-') // em-dash → hyphen
    .replace(/\u2013/g, '-') // en-dash → hyphen
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-') // non-alphanumeric → hyphen
    .replace(/-{2,}/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, ''); // trim leading/trailing hyphens
}
