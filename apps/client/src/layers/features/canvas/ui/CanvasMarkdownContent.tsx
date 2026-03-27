import { Streamdown } from 'streamdown';
import type { UiCanvasContent } from '@dorkos/shared/types';
import 'streamdown/styles.css';

interface CanvasMarkdownContentProps {
  /** Markdown canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'markdown' }>;
}

/**
 * Markdown renderer for canvas content.
 * Uses the same streamdown library as chat messages for consistent rendering.
 */
export function CanvasMarkdownContent({ content }: CanvasMarkdownContentProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none overflow-auto p-6">
      <Streamdown shikiTheme={['github-light', 'github-dark']}>{content.content}</Streamdown>
    </div>
  );
}
