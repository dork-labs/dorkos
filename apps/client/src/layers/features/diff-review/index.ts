/**
 * Diff-review feature (DOR-212) — the per-hunk agent-edit review surface.
 *
 * Public surface: {@link CanvasDiffContent} (the diff canvas viewer the canvas
 * feature dispatches to) and {@link useAutoOpenDiff} (wired once at the app shell
 * to auto-open a diff when the attached agent edits a file). The heavy
 * `@codemirror/merge` renderer is lazy-loaded inside `CanvasDiffContent`, so
 * importing this barrel does not pull the merge runtime into the main bundle.
 *
 * @module features/diff-review
 */
export { CanvasDiffContent } from './ui/CanvasDiffContent';
export { useAutoOpenDiff } from './model/use-auto-open-diff';
