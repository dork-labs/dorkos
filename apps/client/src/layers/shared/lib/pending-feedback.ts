/**
 * A one-shot handoff of a feedback prefill across a page reload (feedback-pipeline
 * PR C).
 *
 * The app-crash boundary (`shared/ui/app-crash-fallback.tsx`) renders when the
 * whole React tree — including the feedback dialog's host — has unmounted, so it
 * cannot open the dialog directly. Instead it stashes a prefill here and reloads;
 * on the next boot the dialog host calls {@link takePendingFeedback} and, if one
 * is waiting, opens the dialog with it. `sessionStorage` (not `localStorage`) so
 * the handoff is scoped to the tab and never lingers into a future session.
 *
 * @module shared/lib/pending-feedback
 */

/** The pending prefill shape carried across a reload (mirrors the store's prefill). */
export interface PendingFeedback {
  /** Which kind to preselect (crash reports use `bug`). */
  kind?: 'feedback' | 'bug' | 'idea';
  /** A starting message (a crash stub from `error.message`). */
  message?: string;
  /** A stack trace to fold into the bug report's diagnostics. */
  crashStack?: string;
}

/** The `sessionStorage` key the handoff lives under. */
const PENDING_FEEDBACK_KEY = 'dorkos:pending-feedback';

/**
 * Stash a feedback prefill for the next boot to pick up. Best-effort: a
 * `sessionStorage` failure (private mode, quota) is swallowed so a crash
 * fallback's reload is never itself blocked.
 *
 * @param pending - The prefill to carry across the reload.
 */
export function stashPendingFeedback(pending: PendingFeedback): void {
  try {
    sessionStorage.setItem(PENDING_FEEDBACK_KEY, JSON.stringify(pending));
  } catch {
    // No durable handoff available — the reload still recovers the app.
  }
}

/**
 * Read and CLEAR any pending feedback prefill. Returns `null` when none is
 * waiting or the stored value is unreadable. One-shot by design: a stale prefill
 * must never re-open the dialog on a later, unrelated reload.
 *
 * @returns The pending prefill, or `null`.
 */
export function takePendingFeedback(): PendingFeedback | null {
  try {
    const raw = sessionStorage.getItem(PENDING_FEEDBACK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_FEEDBACK_KEY);
    return JSON.parse(raw) as PendingFeedback;
  } catch {
    return null;
  }
}
