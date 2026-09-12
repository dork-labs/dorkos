/**
 * Which of the right panel's two document views a piece of canvas content
 * belongs to (ADR 260911-200304).
 *
 * The split is drawn by the renderer, not by a hand-kept list: `CanvasViews`
 * dispatches exactly two content types — `url` and `browser` — to
 * `CanvasBrowserContent`, and the other twelve to eleven other viewers. So the
 * Browser view is "the documents the embedded browser renders" and the Canvas
 * view is everything else. One definition means the tab split can never drift
 * from the viewer dispatch, and `mcp_app` stays in Canvas without being an
 * exception: it has its own viewer, so it is an app rather than a page.
 *
 * **In `@dorkos/shared` rather than in the client**, for the same reason
 * `canvas-source-key` is: since the session canvas moved to the server (spec
 * `canvas-agent-seat`), the SERVER has to answer which document is at the front
 * of each view — `get_ui_state`'s `active` flag, and the document a bare
 * `update_canvas` acts on. Two definitions of "which tab does this belong to"
 * would drift into an agent updating the page somebody is reading instead of
 * the document they asked about.
 *
 * @module shared/canvas-view
 */
import type { UiCanvasContent } from './schemas.js';

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
