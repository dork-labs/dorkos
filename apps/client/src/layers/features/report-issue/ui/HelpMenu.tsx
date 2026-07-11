import { HelpCircle, Bug, Lightbulb, BookOpen } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';
import { useReportIssue } from '@/layers/shared/model';

/** Where the docs live. */
const DOCS_URL = 'https://dorkos.ai/docs';

/**
 * Help menu for the sidebar footer.
 *
 * Always visible. Opens a small menu to report a bug or request a feature (both
 * open a prefilled GitHub issue in a new tab) and to reach the docs. Reporting
 * gathers only safe setup details and sends nothing on its own; the user edits
 * everything in GitHub before submitting.
 */
export function HelpMenu() {
  const reportIssue = useReportIssue();

  return (
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
        <DropdownMenuItem onSelect={() => reportIssue('bug')}>
          <Bug className="size-(--size-icon-sm)" />
          Report a bug
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => reportIssue('feature')}>
          <Lightbulb className="size-(--size-icon-sm)" />
          Request a feature
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => window.open(DOCS_URL, '_blank', 'noopener,noreferrer')}>
          <BookOpen className="size-(--size-icon-sm)" />
          Documentation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
