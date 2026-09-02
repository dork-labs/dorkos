import { createPortal } from 'react-dom';
import { ExternalLink, Copy, X, ShieldAlert } from 'lucide-react';
import type { LinkSafetyModalProps } from 'streamdown';
import { classifyLink, declaredScheme, useCopyFeedback } from '@/layers/shared/lib';

/**
 * The sentence under the heading: what is about to happen, or why nothing can.
 *
 * @param refused - Whether the link seam blocked this link.
 * @param scheme - The scheme the href declares, if it declares one.
 */
function describeLink(refused: boolean, scheme: string | null): string {
  if (!refused) return "You're about to visit an external website.";
  if (!scheme) return 'That address is incomplete, so there is nowhere to send you.';
  return `DorkOS opens web, email and phone links. This is a ${scheme} link, so nothing would happen.`;
}

/**
 * Portal-based external-link confirmation modal — the app's single link-safety
 * surface. Streamdown-compatible (`LinkSafetyModalProps`), so it is callable
 * from any of its three call sites (`MarkdownLink`, gen-UI widget `url`
 * actions, MCP App iframes). Portalled to `document.body` to escape
 * transform-based containing blocks.
 *
 * **It asks the link seam before it offers to open anything** (DOR-547). A
 * scheme `classifyLink` refuses cannot be opened by pressing the button, so
 * offering the button would be a promise the next click breaks — the
 * confirm-then-decline shape this ticket existed to remove, moved one step
 * later rather than fixed. For a refused link the modal says so in place and
 * leads with "Copy link", which is the one thing that still works: the address
 * goes to the reader's clipboard, and whatever they use to open `irc:` links
 * can have it.
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

  // Asked on every render rather than memoised: `classifyLink` is a pure string
  // parse, and the modal renders once per open.
  const refused = classifyLink(url).kind === 'blocked';
  const scheme = declaredScheme(url);
  const description = describeLink(refused, scheme);

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
        <button
          className="text-muted-foreground hover:bg-muted hover:text-foreground absolute top-4 right-4 rounded-md p-1 transition-all"
          onClick={onClose}
          title="Close"
          type="button"
        >
          <X size={16} />
        </button>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-lg font-semibold">
            {refused ? <ShieldAlert size={20} /> : <ExternalLink size={20} />}
            <span>{refused ? "DorkOS can't open this link" : 'Open external link?'}</span>
          </div>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="bg-muted rounded-md p-3 font-mono text-sm break-all">{url}</div>
        <div className="flex gap-3">
          {/* Copy leads for a refused link, because it is the only thing left
              that works — the address reaches the clipboard, and whatever the
              reader uses for this scheme can have it. */}
          <button
            className={
              refused
                ? 'bg-foreground text-background hover:bg-foreground/90 flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors'
                : 'hover:bg-muted flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors'
            }
            onClick={() => {
              void copy(url);
              onClose();
            }}
            type="button"
          >
            <Copy size={14} />
            Copy link
          </button>
          {/* No open button at all for a refused link, rather than a disabled
              one. A greyed-out control still says "this is what you came to
              do"; the sentence above already said why nothing is on offer. */}
          {!refused && (
            <button
              className="bg-foreground text-background hover:bg-foreground/90 flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              onClick={onConfirm}
              type="button"
            >
              <ExternalLink size={14} />
              Open link
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
