import { useId } from 'react';
import { Lock } from 'lucide-react';
import { Button, ResponsiveDialogFooter } from '@/layers/shared/ui';

interface FeedbackFormFooterProps {
  /** Something is attached but nothing is written yet, so Send says why it is off. */
  needsWords: boolean;
  /** Whether Send is live. */
  canSend: boolean;
  /** Whether a send is in flight. */
  isSubmitting: boolean;
  /** Open a prefilled public GitHub issue instead. */
  onOpenGitHubIssue: () => void;
}

/**
 * The feedback form's footer: the privacy line (or, with an attachment and no
 * words, what is missing), Send, and the public GitHub way out under them. It
 * sits outside the form's one scroll region, so Send stays reachable at any
 * height and above a phone's keyboard (DOR-2076).
 */
export function FeedbackFormFooter({
  needsWords,
  canSend,
  isSubmitting,
  onOpenGitHubIssue,
}: FeedbackFormFooterProps) {
  const wordsHintId = useId();
  return (
    <ResponsiveDialogFooter className="shrink-0 flex-col gap-2 sm:flex-col sm:justify-start sm:space-x-0">
      <div className="flex items-center gap-3">
        {needsWords ? (
          <p
            id={wordsHintId}
            aria-live="polite"
            className="text-status-warning min-w-0 flex-1 text-xs"
          >
            Add a few words so we know what to look for.
          </p>
        ) : (
          <p className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-xs">
            <Lock className="size-3 shrink-0" aria-hidden />
            Only the DorkOS team sees this
          </p>
        )}
        <Button
          type="submit"
          disabled={!canSend}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-describedby={needsWords ? wordsHintId : undefined}
          className="shrink-0"
        >
          {isSubmitting ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <p className="text-muted-foreground text-center text-xs">
        Prefer a public GitHub issue?{' '}
        <button
          type="button"
          onClick={onOpenGitHubIssue}
          className="hover:text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
        >
          Open one instead
        </button>
      </p>
    </ResponsiveDialogFooter>
  );
}
