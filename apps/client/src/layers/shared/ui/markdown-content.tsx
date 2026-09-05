/**
 * Static markdown renderer for non-chat content.
 *
 * Wraps streamdown's Streamdown component for rendering markdown in setup
 * guides, help disclosures, info boxes, and widget text nodes. Unlike
 * StreamingText, this has no streaming cursor. Every link renders through the
 * shared {@link MarkdownLink} unconditionally (DOR-1272 round 2) — there is
 * no "trusted surface, skip the confirmation" mode: Streamdown's own default
 * `linkSafety` is `{ enabled: true }` regardless of what a caller passes, so
 * a `MarkdownContent` that opted out would still have gotten Streamdown's own
 * hrefless `<button>` and its own, non-design-system confirm modal. Every
 * surface gets the same real anchor and the same confirmation instead.
 */
import type { ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import type { AllowedTags, Components } from 'streamdown';
// Streamdown's own stylesheet, which is what actually draws this markdown.
// Imported here rather than relied on from elsewhere: it was only ever loaded
// because the chat's `StreamingText` imports it, so every surface that renders
// static markdown was borrowing the styling of a component it does not use, and
// would have lost it the day chat was code-split away from that surface.
import 'streamdown/styles.css';
import { cn } from '@/layers/shared/lib/utils';
import { MarkdownErrorBoundary } from './markdown-error-boundary';
import { MarkdownLink } from './markdown-link';

export interface MarkdownContentProps {
  /** Markdown string to render. */
  content: string;
  /** Additional CSS classes merged onto the container. */
  className?: string;
  /**
   * Shown in place of the markdown if it fails to render (e.g. Streamdown's
   * lazy code-block chunk fails to load). Defaults to a generic muted note;
   * pass copy that fits the surface (e.g. "This README couldn't be displayed.").
   */
  errorFallback?: ReactNode;
  /**
   * Tag → component overrides forwarded straight to Streamdown, for a surface
   * that draws one of its own inline tags (e.g. a room's `<mention>`) as
   * something other than raw HTML. Undefined everywhere else — this component
   * stays ignorant of what any tag means; the caller supplies both the tag and
   * what it renders as.
   */
  components?: Components;
  /**
   * Custom tags (and their permitted attributes) to allow through Streamdown's
   * sanitizer, keyed by tag name. Paired with `components` — a tag left out of
   * both is sanitized away like any other unrecognised HTML.
   *
   * **The trust boundary lives at the call site, not here.** Streamdown
   * renders a tag listed here from ANY matching text in `content` — one this
   * component's caller spliced in from trusted data, or one that arrived
   * verbatim inside otherwise-untrusted `content` (a message a room member
   * typed, say) and merely happens to look the same. This component cannot
   * tell those apart, so a caller allowing a tag whose attributes carry
   * meaning (like an id to look up) must itself gate what that tag is allowed
   * to resolve against — see `the room's body renderer`'s `spannedIds` for the pattern.
   */
  allowedTags?: AllowedTags;
  /**
   * Tag names (a subset of `allowedTags`) whose children Streamdown treats as
   * plain text rather than markdown to re-parse — for a data label like a
   * mention's `@handle`, not prose.
   */
  literalTagContent?: string[];
}

/** Renders static markdown content using streamdown. */
export function MarkdownContent({
  content,
  className,
  errorFallback,
  components,
  allowedTags,
  literalTagContent,
}: MarkdownContentProps) {
  return (
    // desktop:select-text — see message-variants.ts for why: the desktop
    // shell defaults chrome to non-selectable on every platform (DOR-562),
    // and static markdown (setup guides, canvas documents, help text) is
    // genuinely copyable content, not chrome.
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
    <div className={cn('desktop:select-text', className)}>
      {/* Guard the render so a failed code-block chunk degrades to a note here
          instead of throwing to the route boundary. Reset on content change. */}
      <MarkdownErrorBoundary resetKey={content} fallback={errorFallback}>
        <Streamdown
          components={{ ...components, a: MarkdownLink }}
          allowedTags={allowedTags}
          literalTagContent={literalTagContent}
        >
          {content}
        </Streamdown>
      </MarkdownErrorBoundary>
    </div>
  );
}
