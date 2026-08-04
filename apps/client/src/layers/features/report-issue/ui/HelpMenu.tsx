import { useNavigate } from '@tanstack/react-router';
import { HelpCircle, MessageSquarePlus, Bug, Inbox, ExternalLink, BookOpen } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/layers/shared/ui';
import { openLink } from '@/layers/shared/lib';
import { useFeedbackDialogStore, useReportIssue } from '@/layers/shared/model';

/** Where the docs live. */
const DOCS_URL = 'https://dorkos.ai/docs';

/**
 * Help menu for the sidebar footer.
 *
 * Always visible. The two primary actions — "Send feedback" and "Report a bug" —
 * open the same in-app dialog (kind preset), which delivers a message straight to
 * the DorkOS team and is private to the core team. "Feedback & requests" opens
 * the tracking view for what this install has sent. The GitHub path stays
 * available but demoted to a single muted "Report on GitHub…" chooser below a
 * separator — it opens a public issue thread the user edits themselves, the
 * opposite of the private in-app path (design-decisions §1).
 */
export function HelpMenu() {
  const navigate = useNavigate();
  const openFeedback = useFeedbackDialogStore((s) => s.openFeedback);
  const reportIssue = useReportIssue();

  // The `/feedback-requests` route (the tracking view) is added by a parallel
  // PR (PR D); until it lands it is not in the typed router table, so navigate
  // is loosened here on purpose. The path is stable and agreed in the spec.
  const goToFeedbackRequests = () =>
    (navigate as (opts: { to: string }) => void)({ to: '/feedback-requests' });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="text-muted-foreground/50 hover:text-muted-foreground focus-visible:ring-ring rounded-md p-1 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          aria-label="Help and feedback"
        >
          <HelpCircle className="size-(--size-icon-sm)" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-56">
        <DropdownMenuLabel>Help and feedback</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => openFeedback({ kind: 'feedback' })}>
          <MessageSquarePlus className="size-(--size-icon-sm)" />
          Send feedback
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openFeedback({ kind: 'bug' })}>
          <Bug className="size-(--size-icon-sm)" />
          Report a bug
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={goToFeedbackRequests}>
          <Inbox className="size-(--size-icon-sm)" />
          Feedback &amp; requests
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-muted-foreground">
            <ExternalLink className="size-(--size-icon-sm)" />
            Report on GitHub…
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => reportIssue('bug')}>
              <Bug className="size-(--size-icon-sm)" />
              Report a bug
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => reportIssue('feature')}>
              <MessageSquarePlus className="size-(--size-icon-sm)" />
              Request a feature
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem className="text-muted-foreground" onSelect={() => openLink(DOCS_URL)}>
          <BookOpen className="size-(--size-icon-sm)" />
          Documentation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
