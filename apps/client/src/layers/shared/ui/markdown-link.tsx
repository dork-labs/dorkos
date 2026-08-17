/**
 * Streamdown's `a` tag renderer for surfaces that opt into `linkSafety`
 * (`MarkdownContent`'s `linkSafety` prop, chat's `StreamingText`) — a real
 * `<a href>`, not the `<button>` Streamdown's own built-in `linkSafety`
 * handling renders.
 *
 * **Why this exists (DOR-1272).** Streamdown's bundled `a` component
 * (`streamdown@2.5.0`) reads `linkSafety` off context and, whenever it is
 * enabled, renders an `appearance-none` `<button>` in the anchor's place —
 * verified by reading the package's own source, not inferred. A button has no
 * `href`, so hovering shows no destination, cmd/ctrl-click and middle-click
 * have nothing to open into a new tab, and the browser's native "Copy Link
 * Address" has no link to copy. This component keeps the exact same
 * confirm-before-navigate behaviour — an unmodified left click still opens
 * {@link LinkSafetyModal} before anything loads — but on a genuine anchor, so
 * every native affordance a real link offers keeps working. A modified click
 * (cmd/ctrl/shift/alt, a non-primary button) is deliberately left alone: the
 * reader is already telling the browser what to do with it, and intercepting
 * that would be the same loss this component exists to undo.
 *
 * Passed to `Streamdown` as `components={{ a: MarkdownLink }}` — see
 * `contributing/link-dispatch-policy.md` for how this fits the rest of the
 * app's link-dispatch policy.
 */
import { useCallback, useState, type ComponentProps, type MouseEvent } from 'react';
import { cn } from '@/layers/shared/lib';
import { LinkSafetyModal } from './link-safety-modal';

type MarkdownLinkProps = Omit<ComponentProps<'a'>, 'onClick'> & {
  /** Streamdown's hast node for this element — unused; declared only so the
   * prop shape matches what Streamdown's `Components['a']` slot passes. */
  node?: unknown;
};

/**
 * Renders a markdown/autolink `<a>` as a real anchor with a confirm-before-
 * navigate click handler, for any Streamdown instance that opts into link
 * safety.
 *
 * @param props - The anchor's parsed `href`/`className`/children plus any
 * other HTML attributes Streamdown forwards (e.g. a `[text](url "title")`
 * title). `node` is accepted and ignored — see {@link MarkdownLinkProps}.
 */
export function MarkdownLink({
  href,
  className,
  children,
  node: _node,
  ...rest
}: MarkdownLinkProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const handleClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // Anything other than a plain primary-button left click is the reader
    // directly asking the browser for something — a new tab, a new window, a
    // download prompt. Leave it alone so that request is honoured exactly as
    // it would be for any other link on the page.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    setIsConfirmOpen(true);
  }, []);

  const closeConfirm = useCallback(() => setIsConfirmOpen(false), []);
  const confirmAndOpen = useCallback(() => {
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }, [href]);

  return (
    <>
      <a
        data-streamdown="link"
        {...rest}
        className={cn(
          'text-primary rounded-sm font-medium wrap-anywhere underline',
          'focus-ring',
          className
        )}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        onClick={handleClick}
      >
        {children}
      </a>
      <LinkSafetyModal
        url={href ?? ''}
        isOpen={isConfirmOpen}
        onClose={closeConfirm}
        onConfirm={confirmAndOpen}
      />
    </>
  );
}
