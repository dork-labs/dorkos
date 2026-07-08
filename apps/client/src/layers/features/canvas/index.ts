/**
 * Canvas feature: resizable, multi-document agent-driven content pane.
 *
 * The canvas hosts several open documents at once (a tab strip in the header);
 * file/markdown documents are user-editable via a pencil toggle that autosaves
 * to disk. Edit protection is per-document: while a document is being edited its
 * own `editing` flag is set (via `setDocumentEditing`), and the store's
 * `updateActiveDocument`/`openCanvasDocument` honor it so agent pushes to that
 * document are held and the editor stays the sole writer. Each editor clears its
 * own document's flag on unmount, so a tab switch or close mid-edit never leaves
 * a document permanently locked. See ADR 260708-185518 (multi-document canvas),
 * ADR-0290 (unify on Blintz), ADR-0291 (Blintz read-only mode), and ADR-0292
 * (edit protection plus cross-session safety).
 *
 * @module features/canvas
 */
export { AgentCanvas, CanvasContent } from './ui/AgentCanvas';
export { useCanvasPersistence } from './model/use-canvas-persistence';
