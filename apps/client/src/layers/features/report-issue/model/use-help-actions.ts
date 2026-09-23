/**
 * The help-and-feedback actions, once, for every surface that offers them.
 *
 * The desktop sidebar folds them into its `⋯` menu (`HelpMenuItems`); a phone's
 * You tab draws them as rows of their own, because a fold is one tap further
 * from the only way a phone has to send feedback. Both read this list, so the
 * two can never disagree about what is on offer or what a row does.
 *
 * @module features/report-issue/model/use-help-actions
 */
import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Inbox, MessageSquarePlus, type LucideIcon } from 'lucide-react';
import { openLink } from '@/layers/shared/lib';
import { useFeedbackDialogStore } from '@/layers/shared/model';

/** Where the docs live. */
const DOCS_URL = 'https://dorkos.ai/docs';

/** Where the person's own reports live. */
const YOUR_REPORTS_PATH = '/feedback-requests';

/** One help-and-feedback action. */
export interface HelpAction {
  /** Stable id, for keys and test ids. */
  id: 'send-feedback' | 'your-reports' | 'documentation';
  /** The row's label, as a person reads it. */
  label: string;
  /** The row's glyph. */
  icon: LucideIcon;
  /** A way out of the app rather than a place in it, drawn quieter. */
  secondary: boolean;
  /** Do it. */
  run: () => void;
}

/**
 * The three help-and-feedback actions, in menu order.
 *
 * @returns Send feedback, Your reports, and Documentation.
 */
export function useHelpActions(): HelpAction[] {
  const navigate = useNavigate();
  const openFeedback = useFeedbackDialogStore((s) => s.openFeedback);

  return useMemo(
    () => [
      {
        id: 'send-feedback',
        label: 'Send feedback…',
        icon: MessageSquarePlus,
        secondary: false,
        // No kind: the form keeps a half-written draft, kind included, and
        // starts a fresh one as Feedback.
        run: () => openFeedback(),
      },
      {
        id: 'your-reports',
        label: 'Your reports',
        icon: Inbox,
        secondary: false,
        // The route is not in the typed router table, so navigate is loosened
        // here on purpose. The path is stable and agreed in the spec.
        run: () => (navigate as (opts: { to: string }) => void)({ to: YOUR_REPORTS_PATH }),
      },
      {
        id: 'documentation',
        label: 'Documentation',
        icon: BookOpen,
        secondary: true,
        run: () => openLink(DOCS_URL),
      },
    ],
    [navigate, openFeedback]
  );
}
