/**
 * The anchor for a URL **this codebase did not write** — a package's homepage
 * from a remote catalog, a connector's authorize URL from the server, an
 * adapter manifest's action button, an MCP server's sign-in page.
 *
 * **Why this exists (DOR-924).** `openLink`/`openExternalLink` are the app's one
 * scheme allowlist, and DOR-921 closed the last programmatic bypass of them —
 * but a bare `<a href={someUrl}>` never asked them anything. The browser follows
 * that href with none of our code running, so every one of those anchors ran its
 * own policy of "whatever the browser will do with it". React neutralises a
 * literal `javascript:` href on its own; nothing neutralises the rest. This
 * component is what puts those hrefs back on the same policy as everything else,
 * the way `MarkdownLink` did it for markdown links in DOR-547.
 *
 * It is a **real `<a href>` while the link is one**, not a button: hovering
 * shows the destination, the browser's "Copy Link Address" has something to
 * copy, and a cmd/ctrl/shift/alt click still gets the new tab it asked for —
 * but only when the href is an absolute `http:`/`https:` URL, exactly as
 * `MarkdownLink` decides it. A modified click on anything else would reach an
 * OS protocol handler with no warning, so it goes through the seam instead.
 *
 * **When the seam would refuse the link on this surface, no href is rendered at
 * all.** A refusal is knowable before the person acts — `linkRefusalHere`
 * answers it, schemes and desktop shell together — and an href the browser
 * might carry somewhere on a middle-click is not something to leave lying in
 * the DOM once we know we would refuse it. The element stays on screen and stays
 * operable (it is a `role="button"` at that point, keyboard included) so a
 * press still gets the seam's one-sentence explanation rather than silence.
 *
 * Unlike `MarkdownLink` there is **no confirmation modal**. These hrefs are
 * semi-trusted rather than agent-authored prose, and they sit inside flows the
 * person deliberately started — pressing "Open sign-in" is already the
 * confirmation. The scheme policy is what they were missing.
 *
 * See `contributing/link-dispatch-policy.md` for the whole policy.
 *
 * @module shared/ui/external-link-anchor
 */
import { useCallback, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react';
import { isWebUrl, linkRefusalHere, openExternalLink } from '../lib/link-navigation';

export type ExternalLinkAnchorProps = Omit<
  ComponentProps<'a'>,
  // `href` and `onClick` are this component's job. `target` and `rel` are
  // fixed for every caller — each of these links leaves the app — and they are
  // omitted rather than merely overwritten so the type says so too: a caller
  // passing `rel="opener"` should not compile and then be silently ignored.
  'href' | 'onClick' | 'target' | 'rel'
> & {
  /** The URL to open. Any shape, from any source — that is the point. */
  href: string;
  /**
   * Called when the link **actually left** — the browser was handed it, or the
   * reader's own modified click took it. Never called for a link the seam
   * refused.
   *
   * Deliberately not an `onClick`: the callers that want this are recording
   * "the person opened the sign-in page", which gates an "I finished signing
   * in" affordance further down the flow. Firing that on a refusal is how
   * "nothing opened" becomes "you're authorized" — the exact confusion
   * `openExternalLink`'s return value exists to prevent.
   */
  onOpened?: () => void;
};

/**
 * Render a link to an externally-supplied URL, dispatched through the app's
 * link seam.
 *
 * @param props - The untrusted `href`, an optional {@link ExternalLinkAnchorProps.onOpened},
 * plus any anchor attributes to forward (`className`, `aria-label`,
 * `data-testid`, a `ref`). `target` and `rel` are set here and are not
 * caller-configurable — the prop type omits them, so that is a compile error
 * rather than an argument silently dropped: every one of these leaves the app.
 */
export function ExternalLinkAnchor({ href, onOpened, children, ...rest }: ExternalLinkAnchorProps) {
  const refusal = linkRefusalHere(href);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Same rule as `MarkdownLink`: the reader is asking the browser directly
      // for a new tab or window, and an absolute http(s) URL is safe to hand
      // straight to that request. Anything else confirms nothing and reaches an
      // OS handler, so it comes back through the seam.
      const isModified =
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (isModified && refusal === null && isWebUrl(href)) {
        onOpened?.();
        return;
      }
      event.preventDefault();
      if (openExternalLink(href)) onOpened?.();
    },
    [href, onOpened, refusal]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLAnchorElement>) => {
      // Only reachable on the refused branch, where there is no href for the
      // browser to activate — so Enter and Space have to be answered here or a
      // keyboard user gets no explanation at all.
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (openExternalLink(href)) onOpened?.();
    },
    [href, onOpened]
  );

  return (
    <a
      {...rest}
      href={refusal === null ? href : undefined}
      target="_blank"
      rel="noopener noreferrer"
      role={refusal === null ? undefined : 'button'}
      tabIndex={refusal === null ? undefined : 0}
      onClick={handleClick}
      onKeyDown={refusal === null ? undefined : handleKeyDown}
    >
      {children}
    </a>
  );
}
