import { ExternalLink, Copy, ShieldAlert } from 'lucide-react';
import type { LinkSafetyModalProps } from 'streamdown';
import { describeRefusal, linkRefusalHere } from '@/layers/shared/lib/link-navigation';
import { useCopyFeedback } from '@/layers/shared/lib/use-copy-feedback';
import { Button } from './button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog';

/**
 * External-link confirmation modal — the app's single link-safety surface.
 * Streamdown-compatible (`LinkSafetyModalProps`), so it is callable from any
 * of its three call sites (`MarkdownLink`, gen-UI widget `url` actions, MCP
 * App iframes). Built on the shared `Dialog` primitive, which gives it a
 * real focus trap, focus restore, scroll lock and Escape handling for free —
 * a hand-rolled `createPortal` div used to claim `aria-modal` without any of
 * those.
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

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md rounded-xl sm:rounded-xl">
        <DialogTitle className="flex items-center gap-2 text-lg">
          {refused ? <ShieldAlert className="size-5" /> : <ExternalLink className="size-5" />}
          {title}
        </DialogTitle>
        <DialogDescription>{detail}</DialogDescription>
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
      </DialogContent>
    </Dialog>
  );
}
