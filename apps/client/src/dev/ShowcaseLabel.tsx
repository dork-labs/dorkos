import { Copy, Check, X } from 'lucide-react';
import { useCopyFeedback } from '@/layers/shared/lib';

/** The label's copy icon: a check on success, an X on failure, the glyph otherwise. */
function LabelCopyIcon({ copied, failed }: { copied: boolean; failed: boolean }) {
  if (copied) return <Check className="size-3" />;
  if (failed) return <X className="text-destructive size-3" />;
  return <Copy className="size-3" />;
}

/** Shared sub-label for demo sections in the dev playground. */
export function ShowcaseLabel({ children }: { children: string }) {
  const { copied, failed, copy } = useCopyFeedback();

  return (
    <div className="group/label text-muted-foreground mb-2 flex items-center text-xs font-medium tracking-wider uppercase">
      {children}
      <button
        type="button"
        onClick={() => void copy(children)}
        className="text-muted-foreground/0 group-hover/label:text-muted-foreground ml-1.5 transition-colors"
        aria-label={failed ? `Couldn't copy "${children}" — try again` : `Copy "${children}"`}
      >
        <LabelCopyIcon copied={copied} failed={failed} />
      </button>
    </div>
  );
}
