/**
 * Canvas feature: the right panel's multi-document, agent-driven content views.
 *
 * It renders as TWO right-panel tabs over ONE document list (ADR
 * 260911-200304): `BrowserContent` shows the pages the embedded browser renders
 * (`url`, `browser`), `CanvasContent` shows every other type, and each keeps its
 * own active document. Same store, same dedupe, same cap, same persistence.
 *
 * Each view hosts several open documents at once (a tab strip in its header);
 * file/markdown documents are user-editable via a pencil toggle that autosaves
 * to disk. Edit protection is per-document: while a document is being edited its
 * own `editing` flag is set (via `setDocumentEditing`), and the store's
 * `updateActiveDocument`/`openCanvasDocument` honor it so agent pushes to that
 * document are held and the editor stays the sole writer. A held push is kept,
 * not dropped: the canvas shows a quiet banner offering Reload (take the agent's
 * version) or Keep mine, which is ADR-0292's notify-and-reconcile half. Each
 * editor clears its own document's flag on unmount, so a tab switch or close
 * mid-edit never leaves a document permanently locked, and follows the flag out
 * of edit mode when Reload ends the edit for it. See ADR 260708-185518
 * (multi-document canvas),
 * ADR-0290 (unify on Blintz), ADR-0291 (Blintz read-only mode), and ADR-0292
 * (edit protection plus cross-session safety).
 *
 * @module features/canvas
 */
export { CanvasContent, BrowserContent } from './ui/CanvasViews';
export { useCanvasPersistence } from './model/use-canvas-persistence';
