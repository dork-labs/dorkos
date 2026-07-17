/**
 * @module lib/metadata
 *
 * Helpers for building consistent page metadata across the site: deriving a
 * Twitter card from Open Graph values, estimating blog reading time for the
 * post-page label chips, and looking up a source file's real git commit date.
 */
export { twitterFromOpenGraph, type TwitterSource } from './twitter';
export { estimateReadingMinutes, readingTimeLabel } from './reading-time';
export { gitLastModified } from './git-dates';
export { docsSectionTrail, type DocsSection, type DocsPageRef } from './docs-breadcrumb';
export { RSS_FEED_PATH, rssFeedAlternateTypes } from './feed';
