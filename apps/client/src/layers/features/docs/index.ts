/**
 * Docs — what the canvas editor adds to a markdown doc behind the Docs
 * experiment (`docs.enabled`, DOR-2981 to DOR-2984). Today: wiki links
 * between docs in one space, with the `[[` menu; the embed catalog Blintz
 * draws `::chart{…}`-style directives with; and saving a doc as a standalone
 * web page.
 *
 * @module features/docs
 */
export { useDocWikiLinks, type UseDocWikiLinksInput } from './model/use-doc-wiki-links';
export { useDocEmbeds } from './model/use-doc-embeds';
export { SaveAsWebPageButton, type SaveAsWebPageButtonProps } from './ui/SaveAsWebPageButton';
