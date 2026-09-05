import { createPortal } from 'react-dom';
import { ExternalLink, Copy, X, ShieldAlert } from 'lucide-react';
import type { LinkSafetyModalProps } from 'streamdown';
import { describeRefusal, linkRefusalHere } from '@/layers/shared/lib/link-navigation';
import { useCopyFeedback } from '@/layers/shared/lib/use-copy-feedback';
import { Button } from './button';

/**
 * Portal-based external-link confirmation modal — the app's single link-safety
 * surface. Streamdown-compatible (`LinkSafetyModalProps`), so it is callable
 * from any of its three call sites (`MarkdownLink`, gen-UI widget `url`
 * actions, MCP App iframes). Portalled to `document.body` to escape
 * transform-based containing blocks.
 *
 * **It asks the link seam before it offers to open anything** (DOR-547). A link
 * `linkRefusalHere` refuses cannot be opened by pressing the button, so offering
 * the button would be a promise the next click breaks — the confirm-then-decline
 * shape this ticket existed to remove, moved one step later rather than fixed.
 * For a refused link the modal says so in place and leads with "Copy link",
 * which is the one thing that still works: the address goes to the reader's
 * clipboard, and whatever they use to open `irc:` links can have it.
 *
 * The heading and the sentence both come from `describeRefusal`, so this surface
 * and the toast cannot end up saying different things about the same link — they
 * did for one round, and the desktop app told people it does not open `https:`.
 *
 * @param props - The link, the open state, and the close/confirm callbacks
 * Streamdown's `LinkSafetyModalProps` defines. `onConfirm` is unreachable for a
 * refused link, by design.
 */
export function LinkSafetyModal({ url, isOpen, onClose, onConfirm }: LinkSafetyModalProps) {
  // The modal closes the instant "Copy link" is pressed, so there is no
  // chrome left to morph — the toast fallback (`useCopyFeedback`'s TSDoc).
  const { copy } = useCopyFeedback({ toastOnSettle: true });
  if (!isOpen) return null;

  // Asked on every render rather than memoised: this is a pure string parse,
  // and the modal renders once per open.
  //
  // `linkRefusalHere`, not `classifyLink` — the difference is the desktop app.
  // `classifyLink` answers for the policy; this answers for the surface, which
  // is narrower there. Asking the surface-blind question here is exactly the
  // bug the first round of this fix shipped: `mailto:` cleared `classifyLink`,
  // drew an "Open link" button, and then declined at dispatch.
  const refusal = linkRefusalHere(url);
  const refused = refusal !== null;
  const { title, detail } = refusal
    ? describeRefusal(refusal, url)
    : {
        title: 'Open external link?',
        detail: "You're about to visit an external website.",
      };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-streamdown="link-safety-modal"
    >
      {/* Click-away backdrop. Kept as a separate aria-hidden sibling so the
          dialog itself stays in the accessibility tree (an aria-hidden
          ancestor would hide it from assistive tech). */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA dialog pattern requires Escape key handling on the dialog container */}
      <div
        className="bg-background relative mx-4 flex w-full max-w-md flex-col gap-4 rounded-xl border p-6 shadow-lg"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={refused ? 'Link cannot be opened' : 'Open external link confirmation'}
        tabIndex={-1}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground absolute top-4 right-4"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-4" />
        </Button>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-lg font-semibold">
            {refused ? <ShieldAlert size={20} /> : <ExternalLink size={20} />}
            <span>{title}</span>
          </div>
          <p className="text-muted-foreground text-sm">{detail}</p>
        </div>
        <div className="bg-muted rounded-md p-3 font-mono text-sm break-all">{url}</div>
        <div className="flex gap-3">
          {/* Copy leads for a refused link, because it is the only thing left
              that works — the address reaches the clipboard, and whatever the
              reader uses for this scheme can have it. */}
          <Button
            variant={refused ? 'default' : 'outline'}
            className="flex-1"
            onClick={() => {
              void copy(url);
              onClose();
            }}
          >
            <Copy className="size-3.5" />
            Copy link
          </Button>
          {/* No open button at all for a refused link, rather than a disabled
              one. A greyed-out control still says "this is what you came to
              do"; the sentence above already said why nothing is on offer. */}
          {!refused && (
            <Button className="flex-1" onClick={onConfirm}>
              <ExternalLink className="size-3.5" />
              Open link
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
