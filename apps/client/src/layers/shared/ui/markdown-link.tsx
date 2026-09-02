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
 * **A confirmed click leaves through the app's one link seam** (DOR-547):
 * `openExternalLink`, the same call every other confirmed link makes, rather
 * than the raw `window.open` this used to run. Chat markdown is the
 * highest-volume agent-authored link surface in the product, and it used to be
 * the one surface running a different scheme policy from everything else.
 * `irc:`, `ircs:` and `xmpp:` — the only schemes Streamdown's sanitizer lets
 * through that the seam refuses — now stop here, and say so.
 *
 * A scheme the seam refuses never reaches {@link confirmAndOpen} at all:
 * `LinkSafetyModal` asks `linkRefusalHere` when it opens and, for a refused link,
 * explains itself and offers only "Copy link". This handler's job is the click,
 * not the policy, and it stays on the seam so the two cannot drift.
 *
 * Passed to `Streamdown` as `components={{ a: MarkdownLink }}` — see
 * `contributing/link-dispatch-policy.md` for how this fits the rest of the
 * app's link-dispatch policy.
 */
import { memo, useCallback, useState, type ComponentProps, type MouseEvent } from 'react';
import { cn, isWebUrl, openExternalLink } from '@/layers/shared/lib';
import { LinkSafetyModal } from './link-safety-modal';

type MarkdownLinkProps = Omit<ComponentProps<'a'>, 'onClick'> & {
  /** Streamdown's hast node for this element — unused; declared only so the
   * prop shape matches what Streamdown's `Components['a']` slot passes. */
  node?: unknown;
};

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
      // straight to that request. Anything else (a relative path `isWebUrl`
      // deliberately does not resolve, `tel:`, `mailto:`, an `irc:`/`xmpp:`
      // autolink) still confirms even when modified, because a modified click
      // on one of those reaches an OS protocol handler with no warning
      // otherwise.
      //
      // `isWebUrl` is the seam's own predicate, shared with the desktop path
      // (DOR-547) rather than the third private copy of "is this http(s)" this
      // file used to hold. It is **narrower than `DISPATCHABLE_PROTOCOLS` on
      // purpose**: it does not answer "may DorkOS open this?" — `classifyLink`
      // does — but "may the browser have this click without asking?", and only
      // a scheme whose worst case is a new tab qualifies. `mailto:` and `tel:`
      // dispatch through the seam yet still confirm here.
      if (isModified && href !== undefined && isWebUrl(href)) return;
      event.preventDefault();
      setIsConfirmOpen(true);
    },
    [href]
  );

  const closeConfirm = useCallback(() => setIsConfirmOpen(false), []);
  const confirmAndOpen = useCallback(() => {
    // The app's one link policy, same as every other confirmed link
    // (`widget-context.tsx`, `McpAppFrame.tsx`) — DOR-547. This was a raw
    // `window.open` until the seam could explain a refusal out loud; routing
    // here before that landed would have turned "you confirmed, now open" into
    // silence for any scheme the allowlist refuses.
    //
    // `openExternalLink`, not `openLink`: the modal's contract is "this leaves
    // what you are looking at", so a markdown link that happens to name one of
    // our own routes still opens a tab rather than navigating the reply out
    // from under the reader.
    if (href) openExternalLink(href);
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
