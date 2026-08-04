/**
 * Global open/close state for the cockpit feedback dialog (feedback-pipeline
 * PR C).
 *
 * The dialog is opened from several places that are NOT React components in the
 * dialog's own tree: the help menu, the command palette, and — critically — the
 * TanStack Query error toast (`shared/lib/query-client.ts`), whose handler runs
 * outside React. A tiny Zustand store is the seam they all share: any of them
 * can call `useFeedbackDialogStore.getState().openFeedback(...)` without a
 * feature-to-feature import, and a single host (`widgets/app-layout`) renders
 * the one dialog instance from this state. Same pattern as
 * `import-projects-store.ts`.
 *
 * The app-crash boundary does NOT use this store: when it renders, the whole app
 * tree (this store's host included) is unmounted, so it stashes its prefill to
 * `sessionStorage` (`shared/lib/pending-feedback.ts`) and reloads instead — the
 * host reads that on boot.
 *
 * @module shared/model/feedback-dialog/feedback-dialog-store
 */
import { create } from 'zustand';
import type { FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';

/** What an entry point can pre-fill when opening the dialog. */
export interface FeedbackPrefill {
  /** Which kind to preselect. Defaults to `feedback` when omitted. */
  kind?: FeedbackSubmissionKind;
  /** A starting message (e.g. a crash stub or a failed-action summary). */
  message?: string;
  /**
   * A stack trace to fold into the bug report's diagnostics (crash reports).
   * Rides along as a diagnostics breadcrumb so the team sees where it broke.
   */
  crashStack?: string;
}

/** Global open state + prefill for the single {@link FeedbackDialog} instance. */
interface FeedbackDialogState {
  /** Whether the dialog is open. */
  open: boolean;
  /** The prefill for the current open, cleared when the dialog closes. */
  prefill: FeedbackPrefill;
  /** Open the dialog, optionally seeding a kind/message/stack. */
  openFeedback: (prefill?: FeedbackPrefill) => void;
  /** Set the open flag; closing clears the prefill so the next open starts clean. */
  setOpen: (open: boolean) => void;
}

/** Global store powering the feedback dialog's open state (see module doc). */
export const useFeedbackDialogStore = create<FeedbackDialogState>((set) => ({
  open: false,
  prefill: {},
  openFeedback: (prefill = {}) => set({ open: true, prefill }),
  setOpen: (open) => set(open ? { open } : { open: false, prefill: {} }),
}));
