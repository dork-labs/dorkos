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
import { cloneElement, isValidElement, useMemo, type ComponentProps, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import type { AllowedTags, Components, CustomRenderer } from 'streamdown';
// Streamdown's own stylesheet, which is what actually draws this markdown.
// Imported here rather than relied on from elsewhere: it was only ever loaded
// because the chat's `StreamingText` imports it, so every surface that renders
// static markdown was borrowing the styling of a component it does not use, and
// would have lost it the day chat was code-split away from that surface.
import 'streamdown/styles.css';
import { STREAMDOWN_TRANSLATIONS } from '@/layers/shared/lib/streamdown-translations';
import { MarkdownErrorBoundary } from './markdown-error-boundary';
import { MarkdownLink } from './markdown-link';
import { MarkdownImage } from './image-lightbox';

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
  /**
   * Code-fence renderers, keyed by fence language, for a surface that draws one
   * of them as something other than a code block — a room body's
   * ` ```dorkos-ui ` widget fence, say.
   *
   * **The renderer is passed IN, never reached for.** This component is
   * `shared`, so it may not import a feature, and a widget renderer is a
   * feature's (`features/gen-ui`). The caller — a widget, which may import both
   * — supplies it, which is also what keeps the fence's meaning at the surface
   * that decided it has one.
   *
   * Pass a module-scope constant: Streamdown compares its plugin config by
   * identity, so an array rebuilt per render re-renders the whole body every
   * time anything above it does.
   */
  renderers?: CustomRenderer[];
}

/**
 * Streamdown's `pre` override: drops the closing newline from a code block, so
 * "Copy code" copies `echo hello`, not `echo hello\n` (DOR-2871).
 *
 * markdown-to-hast ends a fenced block's text with a newline, and Streamdown's
 * copy button copies that text as is. Pasted into a terminal, the newline is
 * an Enter: the command runs before the person has looked at it. Only that one
 * newline goes; blank lines inside the block stay.
 *
 * Otherwise this is Streamdown's own `pre`: it marks the child `data-block`,
 * which is how its `code` renderer tells a block from inline code. Done here,
 * not as a rehype plugin, because passing `rehypePlugins` replaces Streamdown's
 * defaults (the sanitizer among them) instead of adding to them. Chat's
 * `StreamingText` passes it too.
 */
export function MarkdownCodePre({ children }: ComponentProps<'pre'> & { node?: unknown }) {
  if (!isValidElement<{ children?: ReactNode }>(children)) return children;
  const text = children.props.children;
  const trimmed = typeof text === 'string' && text.endsWith('\n') ? text.slice(0, -1) : text;
  return cloneElement(children, { 'data-block': 'true', children: trimmed } as {
    children?: ReactNode;
  });
}

/** Renders static markdown content using streamdown. */
export function MarkdownContent({
  content,
  className,
  errorFallback,
  components,
  allowedTags,
  literalTagContent,
  renderers,
}: MarkdownContentProps) {
  // Streamdown's top-level memo compares `plugins` by reference, so this must
  // not be a fresh object each render — with a module-scope `renderers` it is
  // then built exactly once for the life of the app.
  const plugins = useMemo(() => (renderers ? { renderers } : undefined), [renderers]);
  return (
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
    <div className={className}>
      {/* Guard the render so a failed code-block chunk degrades to a note here
          instead of throwing to the route boundary. Reset on content change. */}
      <MarkdownErrorBoundary resetKey={content} fallback={errorFallback}>
        <Streamdown
          components={{ img: MarkdownImage, pre: MarkdownCodePre, ...components, a: MarkdownLink }}
          allowedTags={allowedTags}
          literalTagContent={literalTagContent}
          plugins={plugins}
          translations={STREAMDOWN_TRANSLATIONS}
        >
          {content}
        </Streamdown>
      </MarkdownErrorBoundary>
    </div>
  );
}
