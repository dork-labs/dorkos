/**
 * @module lib/metadata/reading-time
 *
 * Estimates how long a blog post takes to read, for the `twitter:label1` /
 * `twitter:data1` chips on post pages. Deliberately simple: strip the obvious
 * markdown/MDX noise, count words, divide by a fixed reading speed.
 */

/** Average adult reading speed, in words per minute. */
const WORDS_PER_MINUTE = 200;

/**
 * Estimate reading time in whole minutes (minimum 1) for a chunk of markdown.
 *
 * Strips frontmatter, code fences, HTML/JSX tags, and markdown punctuation
 * before counting words, so import lines and code blocks don't inflate the
 * estimate. Rounds to the nearest minute.
 *
 * @param markdown - The raw post body (markdown/MDX, frontmatter optional).
 */
export function estimateReadingMinutes(markdown: string): number {
  const text = markdown
    .replace(/^---\n[\s\S]*?\n---/, ' ') // frontmatter block
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/<[^>]+>/g, ' ') // HTML / JSX tags
    .replace(/[#*_>[\]()!-]/g, ' '); // markdown punctuation

  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * Format an estimated reading time as a short human label, e.g. "5 min read".
 *
 * @param markdown - The raw post body.
 */
export function readingTimeLabel(markdown: string): string {
  return `${estimateReadingMinutes(markdown)} min read`;
}
