/**
 * Streamdown's `a` tag renderer for every DorkOS markdown surface —
 * `MarkdownContent` and chat's `StreamingText` — a real `<a href>`, not the
 * `<button>` Streamdown's own `linkSafety` handling renders.
 *
 * **Why this exists (DOR-1272).** Streamdown's bundled `a` component
 * (`streamdown@2.5.0`) reads `linkSafety` off context and, whenever it is
 * enabled, renders an `appearance-none` `<button>` in the anchor's place —
 * verified by reading the package's own source, not inferred. Worse,
 * `linkSafety` **defaults to `{ enabled: true }`** inside Streamdown itself
 * (`chunk-*.js`'s `xn` constant), so a caller that never mentions the prop at
 * all still gets the button — there is no "off" path through Streamdown's own
 * component. A button has no `href`, so hovering shows no destination,
 * cmd/ctrl-click and middle-click have nothing to open into a new tab, and
 * the browser's native "Copy Link Address" has no link to copy.
 *
 * This component is passed to every Streamdown instance in the app —
 * unconditionally — as `components={{ a: MarkdownLink }}`, so Streamdown's
 * own `a` never mounts and its default is never in play. An unmodified left
 * click still opens {@link LinkSafetyModal} before anything loads. A modified
 * click (cmd/ctrl/shift/alt) or a non-primary button is left to the browser
 * **only when the href is an absolute `http:`/`https:` URL** — a cmd-click on
 * a `tel:`/`irc:`/`xmpp:` link would otherwise reach an OS protocol handler
 * with zero warning, and a relative or protocol-relative href is deliberately
 * NOT resolved against the page, so it always confirms too (should-fix 3,
 * DOR-1272 round 2).
 *
 * Passed to `Streamdown` as `components={{ a: MarkdownLink }}` — see
 * `contributing/link-dispatch-policy.md` for how this fits the rest of the
 * app's link-dispatch policy.
 */
import { memo, useCallback, useState, type ComponentProps, type MouseEvent } from 'react';
import { cn } from '@/layers/shared/lib';
import { LinkSafetyModal } from './link-safety-modal';

type MarkdownLinkProps = Omit<ComponentProps<'a'>, 'onClick'> & {
  /** Streamdown's hast node for this element — unused; declared only so the
   * prop shape matches what Streamdown's `Components['a']` slot passes. */
  node?: unknown;
};

/**
 * Whether `href` is an absolute `http:`/`https:` URL.
 *
 * Mirrors the desktop shell's own `isWebLink` (`apps/desktop/src/main/window-
 * manager.ts`) — http(s) only, no `mailto:` exception — but is not imported
 * from it: that file is Electron main-process code, a different process and a
 * different bundle from this component. `new URL(href)` is given no base, on
 * purpose: a relative path or a protocol-relative `//host/path` is exactly
 * what a browser WOULD resolve against the current page, and resolving it
 * here would make it look "safe" to bypass confirmation on. Failing the parse
 * instead means those hrefs always confirm, same as any other non-http(s)
 * scheme.
 *
 * @param href - The anchor's `href`, as Streamdown parsed it.
 */
function isHttpUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function MarkdownLinkImpl({ href, className, children, node: _node, ...rest }: MarkdownLinkProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // `event.button !== 0` is belt-and-braces, not the check doing the real
      // work for a middle click: browsers fire `auxclick`, not `click`, for a
      // non-primary button, so React's onClick (which listens for `click`)
      // never sees button 1 from a real middle click — only from a synthetic
      // `fireEvent.click(el, { button: 1 })` in a test. Kept anyway: nothing
      // guarantees every future caller reaches this handler only through a
      // genuine `click` event.
      const isModified =
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      // The reader is directly asking the browser for something — a new tab,
      // a new window — and an absolute http(s) URL is safe to hand it
      // straight to that request. Anything else (a relative path this
      // component deliberately would not resolve, `tel:`, `mailto:`, an
      // `irc:`/`xmpp:` autolink) still confirms even when modified, because a
      // modified click on one of those reaches an OS protocol handler with no
      // warning otherwise.
      if (isModified && href !== undefined && isHttpUrl(href)) return;
      event.preventDefault();
      setIsConfirmOpen(true);
    },
    [href]
  );

  const closeConfirm = useCallback(() => setIsConfirmOpen(false), []);
  const confirmAndOpen = useCallback(() => {
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
    setIsConfirmOpen(false);
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
        // Stop the row's own right-click menu (Radix `ContextMenuTrigger`,
        // `the room's body renderer`) from ever seeing this event, so the BROWSER's
        // native link menu wins instead — "Copy Link Address", "Open Link in
        // New Tab", and so on (DOR-1272 blocker 1). React's synthetic events
        // walk the React tree, not the raw DOM, so stopping propagation here
        // reaches exactly as far up as the anchor's own ancestors — nothing
        // outside this link's own row is affected. The identical `contextmenu`
        // DOM event fires for the keyboard path too (Shift+F10 / the
        // ContextMenu key on a focused link), so a keyboard user who tabs
        // onto a link and opens a context menu gets the same browser link
        // menu a mouse user does — not the row's action menu. That is the
        // intended behaviour, not a gap: it is what focusing a real link and
        // asking for its context menu means on the rest of the web.
        onContextMenu={(event) => event.stopPropagation()}
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

/**
 * Bails a re-render when neither this link's identity nor its label changed.
 * Streamdown's own default `a` was memoised the same way (`href`-aware); a
 * token-by-token streaming reply re-renders every markdown block per chunk,
 * so without this every link on screen would redo its render work — recompute
 * classes, rebuild the modal element — on every token, not just the ones
 * whose text actually grew. (This is a render-cost optimisation only: a
 * link's own `useState` already survives a parent re-render on its own, with
 * or without `memo`, as long as it stays at the same position in the tree.)
 *
 * Scoped to the props DorkOS's own markdown pipelines ever vary: `href`,
 * `className`, `children` (a link's label), and `title` (the one HTML
 * attribute markdown syntax itself can carry — `[text](url "title")`). A
 * caller that starts forwarding some other attribute through `...rest` would
 * need to extend this list, the same way Streamdown's own comparator would.
 */
function areLinkPropsEqual(prev: MarkdownLinkProps, next: MarkdownLinkProps): boolean {
  return (
    prev.href === next.href &&
    prev.className === next.className &&
    prev.children === next.children &&
    prev.title === next.title
  );
}

/**
 * Renders a markdown/autolink `<a>` as a real anchor with a confirm-before-
 * navigate click handler, for every Streamdown instance in the app.
 *
 * @param props - The anchor's parsed `href`/`className`/children plus any
 * other HTML attributes Streamdown forwards (e.g. a `[text](url "title")`
 * title). `node` is accepted and ignored — see {@link MarkdownLinkProps}.
 */
export const MarkdownLink = memo(MarkdownLinkImpl, areLinkPropsEqual);
