/**
 * @module lib/metadata
 *
 * Helpers for building consistent page metadata across the site: deriving a
 * Twitter card from Open Graph values, and estimating blog reading time for the
 * post-page label chips.
 */
export { twitterFromOpenGraph, type TwitterSource } from './twitter';
export { estimateReadingMinutes, readingTimeLabel } from './reading-time';
