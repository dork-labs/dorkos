/**
 * Which of the right panel's two document views a piece of canvas content
 * belongs to (ADR 260911-200304).
 *
 * The split is drawn by the renderer, not by a hand-kept list: `AgentCanvas`
 * dispatches exactly two content types — `url` and `browser` — to
 * `CanvasBrowserContent`, and the other twelve to eleven other viewers. So the
 * Browser view is "the documents the embedded browser renders" and the Canvas
 * view is everything else. One definition means the tab split can never drift
 * from the viewer dispatch, and `mcp_app` stays in Canvas without being an
 * exception: it has its own viewer, so it is an app rather than a page.
 *
 * Lives in `lib` rather than in the canvas slice so the slice, the persistence
 * helpers and the UI-command dispatcher can all read it without importing each
 * other.
 *
 * @module shared/lib/canvas-view
 */
import type { UiCanvasContent } from '@dorkos/shared/types';

/** One of the right panel's two document views. */
export type CanvasView = 'canvas' | 'browser';

/**
 * The view a document belongs to, derived from the viewer its content renders in.
 *
 * @param content - The document's content variant.
 * @returns `'browser'` for the two types the embedded browser renders, else `'canvas'`.
 */
export function canvasViewForContent(content: UiCanvasContent): CanvasView {
  return content.type === 'url' || content.type === 'browser' ? 'browser' : 'canvas';
}
