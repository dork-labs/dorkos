import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { ErrorCategory } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

const ERROR_COPY: Record<
  ErrorCategory,
  { heading: string; subtext: string; retryable: boolean }
> = {
  max_turns: {
    heading: 'Turn limit reached',
    subtext: 'The agent ran for its maximum number of turns.',
    retryable: false,
  },
  execution_error: {
    heading: 'Agent stopped unexpectedly',
    subtext: 'An error occurred during execution.',
    retryable: true,
  },
  budget_exceeded: {
    heading: 'Cost limit reached',
    subtext: 'This session exceeded its budget.',
    retryable: false,
  },
  output_format_error: {
    heading: 'Output format error',
    subtext: "The agent couldn't produce the required output format.",
    retryable: false,
  },
};

interface ErrorMessageBlockProps {
  message: string;
  category?: ErrorCategory;
  details?: string;
  onRetry?: () => void;
  /** Override the category-derived heading. */
  heading?: string;
  /** Override the category-derived subtext. */
  subtext?: string;
}

/**
 * Inline error block rendered in the assistant message stream.
 * Shows category-specific heading/sub-text, optional retry button,
 * and collapsible raw error details.
 */
export function ErrorMessageBlock({
  message,
  category,
  details,
  onRetry,
  heading: headingOverride,
  subtext: subtextOverride,
}: ErrorMessageBlockProps) {
  const [showDetails, setShowDetails] = useState(false);
  const copy = category ? ERROR_COPY[category] : null;
  const heading = headingOverride ?? copy?.heading ?? 'Error';
  const subtext = subtextOverride ?? copy?.subtext ?? message;
  // When a category is provided, use its retryable flag. When no category,
  // trust the caller — if they passed onRetry, they want the button.
  const retryable = copy?.retryable ?? !!onRetry;

  return (
    <div
      className={cn(
        'my-2 rounded-lg border px-4 py-3',
        'border-destructive/30 bg-destructive/5 text-foreground'
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{heading}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtext}</p>
          {details && (
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {showDetails ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              Details
            </button>
          )}
          {showDetails && details && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
              {details}
            </pre>
          )}
        </div>
        {retryable && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 gap-1.5">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
