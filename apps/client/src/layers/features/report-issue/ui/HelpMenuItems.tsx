/**
 * Help and feedback, as menu ITEMS rather than a menu.
 *
 * It used to be a dropdown of its own with a `?` trigger in the sidebar footer.
 * The footer is one slim strip now (spec `sidebar-now-today-library` BC-47) and
 * has no room for a second trigger, so the items moved into the strip's `⋯`
 * fold — the same dual-render convention the sidebar's row and section menus
 * already use, where a builder owns the nodes and the surface owns the chrome.
 *
 * Nothing about what it offers changed: the private in-app path first, the
 * public GitHub path demoted below its own sub-menu, docs last
 * (design-decisions §1).
 *
 * @module features/report-issue/ui/HelpMenuItems
 */
import { useNavigate } from '@tanstack/react-router';
import { MessageSquarePlus, Bug, Inbox, ExternalLink, BookOpen } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/layers/shared/ui';
import { openLink } from '@/layers/shared/lib';
import { useFeedbackDialogStore, useReportIssue } from '@/layers/shared/model';

/** Where the docs live. */
const DOCS_URL = 'https://dorkos.ai/docs';

/**
 * The help-and-feedback rows, for a dropdown the caller owns.
 *
 * Rendered as a fragment on purpose: the caller decides whether these sit at the
 * top level of its menu or inside a sub-menu, and adds its own separators.
 */
export function HelpMenuItems() {
  const navigate = useNavigate();
  const openFeedback = useFeedbackDialogStore((s) => s.openFeedback);
  const reportIssue = useReportIssue();

  // The `/feedback-requests` route is not in the typed router table, so navigate
  // is loosened here on purpose. The path is stable and agreed in the spec.
  const goToFeedbackRequests = () =>
    (navigate as (opts: { to: string }) => void)({ to: '/feedback-requests' });

  return (
    <>
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
        Product feedback
      </DropdownMenuItem>
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
    </>
  );
}
