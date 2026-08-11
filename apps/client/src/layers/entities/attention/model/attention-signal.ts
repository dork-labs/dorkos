/**
 * One thing that needs the operator, in the one shape every surface reads it in
 * (spec `sidebar-now-today-library` §A1, BC-5).
 *
 * Before this, "what needs me?" was answered twice from two different slices —
 * `features/approvals` for the permission queue and `features/dashboard-attention`
 * for the heuristics — and the sidebar is allowed to import neither. Normalizing
 * here is the FSD fix and the de-duplication in the same move: the entity owns
 * the shape, the feature slices keep their own surfaces.
 *
 * @module entities/attention/model/attention-signal
 */

/**
 * The only four blockages that may reach the operator's Heads up zone (BC-5).
 *
 * An allowlist, not a filter over an exclusion list. Mentions, DMs, unread
 * channels, automated-session activity and update-ready notices have no member
 * here, so no future branch can add one by widening a condition — it would have
 * to widen this union first, and that is a review conversation.
 *
 * This union must stay assignable to the sidebar model's `NowKind`. Nothing
 * asserts it in a test; the assignment in `useSidebarState` is the assertion,
 * and it stops compiling the day the two disagree.
 */
export type AttentionSignalKind = 'permission-prompt' | 'question' | 'error' | 'idle-timeout';

/**
 * One blockage, normalized.
 *
 * Everything here is a fact about the blockage rather than a rendering of it:
 * no icon, no colour, no relative time. `since` is the instant it started
 * waiting, and whoever draws it decides whether that becomes "9m" or nothing at
 * all — the sidebar's standing rule is that a relative timestamp never enters
 * its model (`contributing/sidebar-model.md`).
 */
export interface AttentionSignal {
  /**
   * Stable id of the blockage.
   *
   * Stable across polls and re-renders, because it is what a dismissal is keyed
   * by (BC-10) and what React lists rows by. Namespaced per source
   * (`approval:…`, `blocked:…`, `error:…`, `idle:…`) so two sources can never
   * mint the same id for different things.
   */
  id: string;
  /** Which of the four blockages this is. Drives Heads up's priority order (BC-6). */
  kind: AttentionSignalKind;
  /** Who needs you — the agent's name where there is one, else what asked. */
  primary: string;
  /** What it needs, printed after `›`. Absent when there is nothing to add. */
  secondary?: string;
  /** When it started waiting, ISO-8601. Oldest first within a tier (BC-6). */
  since: string;
  /** Where clicking it goes — the approval, the question, the wedged session. */
  deepLink: string;
  /** Whether the operator may wave it away. Idle nudges only (BC-10, BC-42). */
  dismissible: boolean;
  /** The agent this is about, when there is a face to draw. */
  agentPath?: string;
}
