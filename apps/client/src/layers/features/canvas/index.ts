/**
 * Canvas feature: resizable agent-driven content pane.
 *
 * The markdown variant is user-editable: one Blintz editor renders read-only in
 * view and editable behind a pencil toggle, autosaving per session. While the
 * user edits, agent pushes to that canvas are held (the dispatcher honors the
 * store's `canvasEditing` flag) so the editor is the sole writer. See ADR-0290
 * (unify on Blintz), ADR-0291 (Blintz read-only mode), and ADR-0292 (edit
 * protection plus cross-session safety).
 *
 * @module features/canvas
 */
export { AgentCanvas, CanvasContent } from './ui/AgentCanvas';
export { useCanvasPersistence } from './model/use-canvas-persistence';
