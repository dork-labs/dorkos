/**
 * PIP panel host — routes serializable PipContent descriptors to their
 * renderer inside the shared floating-panel primitive. The content-blind
 * primitive and the typed content union live in shared/ui and shared/model;
 * this feature is the only place that knows how each `kind` renders (mirrors
 * features/canvas routing UiCanvasContent).
 *
 * @module features/pip-panel
 */
export { PipHost } from './ui/PipHost';
