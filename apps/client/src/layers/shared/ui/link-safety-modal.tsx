import { createPortal } from 'react-dom';
import { ExternalLink, Copy, X } from 'lucide-react';
import type { LinkSafetyModalProps } from 'streamdown';

/**
 * Portal-based external-link confirmation modal — the app's single link-safety
 * surface. Streamdown-compatible (`LinkSafetyModalProps`), so it plugs into any
 * Streamdown `linkSafety.renderModal` and is equally callable directly (widget
 * `url` actions). Portalled to `document.body` to escape transform-based
 * containing blocks.
 */
export function LinkSafetyModal({ url, isOpen, onClose, onConfirm }: LinkSafetyModalProps) {
  if (!isOpen) return null;

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
        aria-label="Open external link confirmation"
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
            <ExternalLink size={20} />
            <span>Open external link?</span>
          </div>
          <p className="text-muted-foreground text-sm">
            You&apos;re about to visit an external website.
          </p>
        </div>
        <div className="bg-muted rounded-md p-3 font-mono text-sm break-all">{url}</div>
        <div className="flex gap-3">
          <button
            className="hover:bg-muted flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(url);
              onClose();
            }}
            type="button"
          >
            <Copy size={14} />
            Copy link
          </button>
          <button
            className="bg-foreground text-background hover:bg-foreground/90 flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            onClick={onConfirm}
            type="button"
          >
            <ExternalLink size={14} />
            Open link
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
