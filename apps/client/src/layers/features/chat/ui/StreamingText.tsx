import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Streamdown } from 'streamdown';
import type { LinkSafetyModalProps } from 'streamdown';
import { ExternalLink, Copy, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

/** Portal-based link safety modal that escapes transform-based containing blocks */
function LinkSafetyModal({ url, isOpen, onClose, onConfirm }: LinkSafetyModalProps) {
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-streamdown="link-safety-modal"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      role="button"
      tabIndex={0}
    >
      <div
        className="relative mx-4 flex w-full max-w-md flex-col gap-4 rounded-xl border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <button
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
          onClick={onClose}
          title="Close"
          type="button"
        >
          <X size={16} />
        </button>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <ExternalLink size={20} />
            <span>Open external link?</span>
          </div>
          <p className="text-muted-foreground text-sm">
            You&apos;re about to visit an external website.
          </p>
        </div>
        <div className="break-all rounded-md bg-muted p-3 font-mono text-sm">
          {url}
        </div>
        <div className="flex gap-3">
          <button
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
            onClick={() => { navigator.clipboard.writeText(url); onClose(); }}
            type="button"
          >
            <Copy size={14} />
            Copy link
          </button>
          <button
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            onClick={onConfirm}
            type="button"
          >
            <ExternalLink size={14} />
            Open link
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkSafetyModal {...props} />,
};

export function StreamingText({ content, isStreaming = false }: StreamingTextProps) {
  return (
    <div className={cn('relative', isStreaming && 'streaming-cursor')}>
      <Streamdown shikiTheme={['github-light', 'github-dark']} linkSafety={linkSafety}>
        {content}
      </Streamdown>
    </div>
  );
}
