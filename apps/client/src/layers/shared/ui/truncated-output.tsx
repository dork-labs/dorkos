import { useState } from 'react';
import { cn } from '@/layers/shared/lib/utils';
import { Button } from './button';

/** Maximum characters to render before truncation (5KB). */
const TRUNCATE_THRESHOLD = 5120;

export interface TruncatedOutputProps {
  /** Text content to display, truncated if over threshold. */
  content: string;
  /** Maximum characters before truncation. Defaults to {@link TRUNCATE_THRESHOLD}. */
  threshold?: number;
  /** Chrome for the wrapper — margins, borders. The caller owns it. */
  className?: string;
  'data-testid'?: string;
}

/**
 * Verbatim tool output, with the two protections any transcript text needs.
 *
 * **Newlines survive.** `whitespace-pre-wrap` is the whole point: this renders
 * text a MACHINE wrote — a stack trace, a shell pipeline, a refusal quoting the
 * multi-line command it blocked — where the line breaks carry the structure. A
 * plain `<p>` collapses them into one run-on line, which is how a six-line
 * pipeline becomes unreadable (DOR-1293).
 *
 * **Length is bounded.** A failed tool can return tens of thousands of
 * characters, and a transcript that renders all of it in place is a transcript
 * you cannot scroll past. Clamped to `max-h-48` with its own scroll, and cut at
 * `threshold` behind a one-way "Show full output" toggle.
 *
 * Extracted from `ToolCallCard` so the receipt and question rows show their
 * result the same way the tool card does — one behaviour, not three.
 */
export function TruncatedOutput({
  content,
  threshold = TRUNCATE_THRESHOLD,
  className,
  ...dataProps
}: TruncatedOutputProps) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = content.length > threshold;
  const displayContent = isTruncated && !showFull ? content.slice(0, threshold) : content;

  return (
    <div data-slot="truncated-output" className={cn(className)} {...dataProps}>
      <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
      {isTruncated && !showFull && (
        <Button
          variant="link"
          size="xs"
          onClick={() => setShowFull(true)}
          className="text-muted-foreground hover:text-foreground mt-1 h-auto px-0 underline"
        >
          Show full output ({(content.length / 1024).toFixed(1)}KB)
        </Button>
      )}
    </div>
  );
}
