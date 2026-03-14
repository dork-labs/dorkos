/**
 * Static markdown renderer for non-chat content.
 *
 * Wraps streamdown's Streamdown component for rendering markdown
 * in setup guides, help disclosures, and info boxes. Unlike
 * StreamingText, this has no streaming cursor or link safety modal.
 */
import { Streamdown } from 'streamdown';
import { cn } from '@/layers/shared/lib';

interface MarkdownContentProps {
  /** Markdown string to render. */
  content: string;
  /** Additional CSS classes merged onto the prose container. */
  className?: string;
}

/** Renders static markdown content using streamdown. */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <Streamdown>{content}</Streamdown>
    </div>
  );
}
