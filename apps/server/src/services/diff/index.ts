/**
 * Diff-review domain (DOR-212) — the per-session pre-edit baseline store and the
 * text-diff base resolution behind the per-hunk review surface.
 *
 * @module services/diff
 */
export { editBaselineStore, EditBaselineStore } from './edit-baseline.js';
export type { Baseline, BaselineOrigin } from './edit-baseline.js';
export { gitShowHead } from './git-baseline.js';
export { reconstructPreImage } from './reconstruct.js';
export { resolveTextBaseline } from './resolve-baseline.js';
export type { ResolveBaselineResult, ResolveBaselineError } from './resolve-baseline.js';
