/**
 * Diff-review feature (DOR-212) — the per-hunk agent-edit review surface.
 *
 * Public surface: {@link CanvasDiffContent} (the diff canvas viewer the canvas
 * feature dispatches to), {@link RoomWorktreeDiff} (the same merge view over an
 * agent's working copy and the room's own, with the operator's merge on its
 * header — spec `canvas-agent-seat` §8) and {@link useAutoOpenDiff} (wired once
 * at the app shell to auto-open a diff when the attached agent edits a file). The heavy
 * `@codemirror/merge` renderer is lazy-loaded inside `CanvasDiffContent`, so
 * importing this barrel does not pull the merge runtime into the main bundle.
 *
 * @module features/diff-review
 */
export { CanvasDiffContent } from './ui/CanvasDiffContent';
export { RoomWorktreeDiff } from './ui/RoomWorktreeDiff';
export type { RoomWorktreeDiffProps } from './ui/RoomWorktreeDiff';
export { useAutoOpenDiff } from './model/use-auto-open-diff';
