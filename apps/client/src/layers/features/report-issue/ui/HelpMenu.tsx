import { useState } from 'react';
import { HelpCircle, MessageSquarePlus, Bug, Lightbulb, BookOpen } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';
import { FeedbackDialog } from '@/layers/features/feedback';
import { useReportIssue } from '@/layers/shared/model';

/** Where the docs live. */
const DOCS_URL = 'https://dorkos.ai/docs';

/**
 * Help menu for the sidebar footer.
 *
 * Always visible. The friendly primary action, "Send feedback", opens a small
 * dialog that delivers a message straight to the DorkOS team. The developer
 * fallbacks stay alongside it: "Report a bug" and "Request a feature" each open
 * a prefilled GitHub issue (gathering only safe setup details, sending nothing
 * on their own — the user edits everything in GitHub before submitting).
 */
export function HelpMenu() {
  const reportIssue = useReportIssue();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150"
            aria-label="Help and feedback"
          >
            <HelpCircle className="size-(--size-icon-sm)" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-52">
          <DropdownMenuLabel>Help and feedback</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
            <MessageSquarePlus className="size-(--size-icon-sm)" />
            Send feedback
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => reportIssue('bug')}>
            <Bug className="size-(--size-icon-sm)" />
            Report a bug on GitHub
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => reportIssue('feature')}>
            <Lightbulb className="size-(--size-icon-sm)" />
            Request a feature on GitHub
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => window.open(DOCS_URL, '_blank', 'noopener,noreferrer')}>
            <BookOpen className="size-(--size-icon-sm)" />
            Documentation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}
