/**
 * Static markdown renderer for non-chat content.
 *
 * Wraps streamdown's Streamdown component for rendering markdown in setup
 * guides, help disclosures, info boxes, and widget text nodes. Unlike
 * StreamingText, this has no streaming cursor; external-link confirmation is
 * opt-in via `linkSafety`.
 */
import type { ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import type { LinkSafetyModalProps } from 'streamdown';
import { cn } from '@/layers/shared/lib';
import { LinkSafetyModal } from './link-safety-modal';
import { MarkdownErrorBoundary } from './markdown-error-boundary';

interface MarkdownContentProps {
  /** Markdown string to render. */
  content: string;
  /** Additional CSS classes merged onto the prose container. */
  className?: string;
  /**
   * Confirm external links through the shared {@link LinkSafetyModal} before
   * opening (the same conventions as chat links). Off by default — most static
   * surfaces (setup guides, help text) carry only trusted links.
   */
  linkSafety?: boolean;
  /**
   * Shown in place of the markdown if it fails to render (e.g. Streamdown's
   * lazy code-block chunk fails to load). Defaults to a generic muted note;
   * pass copy that fits the surface (e.g. "This README couldn't be displayed.").
   */
  errorFallback?: ReactNode;
}

const LINK_SAFETY_CONFIG = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkSafetyModal {...props} />,
};

/** Renders static markdown content using streamdown. */
export function MarkdownContent({
  content,
  className,
  linkSafety = false,
  errorFallback,
}: MarkdownContentProps) {
  return (
    // desktop-darwin:select-text — see message-variants.ts for why: the
    // desktop shell defaults chrome to non-selectable, and static markdown
    // (setup guides, canvas documents, help text) is genuinely copyable
    // content, not chrome.
    <div
      className={cn(
        'prose prose-sm dark:prose-invert desktop-darwin:select-text max-w-none',
        className
      )}
    >
      {/* Guard the render so a failed code-block chunk degrades to a note here
          instead of throwing to the route boundary. Reset on content change. */}
      <MarkdownErrorBoundary resetKey={content} fallback={errorFallback}>
        <Streamdown linkSafety={linkSafety ? LINK_SAFETY_CONFIG : undefined}>{content}</Streamdown>
      </MarkdownErrorBoundary>
    </div>
  );
}
