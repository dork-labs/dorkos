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
// Streamdown's own stylesheet, which is what actually draws this markdown.
// Imported here rather than relied on from elsewhere: it was only ever loaded
// because the chat's `StreamingText` imports it, so every surface that renders
// static markdown was borrowing the styling of a component it does not use, and
// would have lost it the day chat was code-split away from that surface.
import 'streamdown/styles.css';
import { cn } from '@/layers/shared/lib';
import { LinkSafetyModal } from './link-safety-modal';
import { MarkdownErrorBoundary } from './markdown-error-boundary';

interface MarkdownContentProps {
  /** Markdown string to render. */
  content: string;
  /** Additional CSS classes merged onto the container. */
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
    //
    // **No `prose` classes here, and that is deliberate rather than an
    // oversight.** They were on this container for a long time and generated no
    // CSS at all: `@tailwindcss/typography` is not a dependency of this app and
    // never has been, so `prose prose-sm dark:prose-invert` were three names
    // Tailwind had no rule for and `max-w-none` was cancelling a max-width
    // nothing was setting. What actually draws this markdown is Streamdown,
    // which bakes its own utility classes into every element it renders (the
    // `@source` line in `index.css` is what makes Tailwind emit them) and ships
    // the stylesheet imported above for the rest. Adding the plugin would have
    // meant a new dependency whose typography then had to be reconciled with
    // Streamdown's, to restyle surfaces that already look right.
    <div className={cn('desktop-darwin:select-text', className)}>
      {/* Guard the render so a failed code-block chunk degrades to a note here
          instead of throwing to the route boundary. Reset on content change. */}
      <MarkdownErrorBoundary resetKey={content} fallback={errorFallback}>
        <Streamdown linkSafety={linkSafety ? LINK_SAFETY_CONFIG : undefined}>{content}</Streamdown>
      </MarkdownErrorBoundary>
    </div>
  );
}
