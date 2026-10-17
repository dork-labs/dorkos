/**
 * Docs — what the canvas editor adds to a markdown doc behind the Docs
 * experiment (`docs.enabled`, DOR-2981 to DOR-2984). Today: wiki links
 * between docs in one space, with the `[[` menu; the embed catalog Blintz
 * draws `::chart{…}`-style directives with; saving a doc as a standalone web
 * page; comments beside a file-backed doc, highlighted in the editor
 * (DOR-2983); and live editing (DOR-2984): {@link LiveDocEditor} joins a
 * doc's live copy on the server, so people and agents edit it together and an
 * agent's write merges in instead of overwriting typing.
 *
 * @module features/docs
 */
export { useDocWikiLinks, type UseDocWikiLinksInput } from './model/use-doc-wiki-links';
export { useDocEmbeds } from './model/use-doc-embeds';
export { SaveAsWebPageButton, type SaveAsWebPageButtonProps } from './ui/SaveAsWebPageButton';
export { DocCommentsFrame, type DocCommentsFrameProps } from './ui/DocCommentsFrame';
export { LiveDocEditor, type LiveDocEditorProps, type LiveEditorBinding } from './ui/LiveDocEditor';
export { DocCollabProvider } from './model/doc-collab-provider';
