/**
 * Attention entity — the one normalized answer to "what needs me right now?"
 * (spec `sidebar-now-today-library` §A1).
 *
 * Two surfaces ask it: the sidebar's Now zone and the home surface's triage
 * header. Their sources used to live in two sibling feature slices, which meant
 * neither surface could read the other's answer and the sidebar could read
 * neither. The normalization lives here so both read the same list, and the
 * feature slices keep their own surfaces — the cards, the rows, the sheets.
 *
 * What is **not** here: rendering. A signal carries facts (`kind`, `since`,
 * `deepLink`), never an icon, a colour or a relative time.
 *
 * The barrel is deliberately narrow. `deriveAttentionSignals` and its input
 * shape are how the hook is built, not what a consumer needs — they are
 * imported by their own tests from inside the slice, which is where an
 * implementation detail should be reachable from.
 *
 * @module entities/attention
 */
export type { AttentionSignal } from './model/attention-signal';
export { dismissIdleNudge, useIdleNudgeStore } from './model/idle-nudge-store';
export { useAttentionSignals } from './model/use-attention-signals';
export { usePendingApprovals, PENDING_APPROVALS_QUERY_KEY } from './model/use-pending-approvals';
