import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ChevronUp, X } from 'lucide-react';
import { useVisualViewportBottomInset, type PipContent } from '@/layers/shared/model';

/** Bar height in px — must match the `h-16` class and the `--pip-dock` value. */
const BAR_HEIGHT = 64;

/** Calm-Tech feel: a firm spring that settles in ~200ms without wobble. */
const SPRING = { type: 'spring', stiffness: 480, damping: 44 } as const;

interface PipMiniBarProps {
  /** The descriptor tucked away. Non-null: the host only mounts the bar while open. */
  content: PipContent;
  /** Bring the sheet back (at peek). Wired to `restorePip`. */
  onRestore: () => void;
  /** Close PIP entirely. Wired to `closePip`. */
  onClose: () => void;
}

/**
 * Minimized mobile PIP state (spec Amendment 2, the Spotify mini-player
 * pattern): a 64px bar docked to the bottom edge showing a live-pulse dot and
 * the content title. Tapping the bar restores the sheet at peek; the X closes
 * PIP entirely. Two real buttons, so it is keyboard-accessible by construction.
 *
 * While mounted, sets `--pip-dock: 64px` on the document root; the app shells
 * consume it as bottom padding so ALL page content — including the session
 * composer — lifts above the bar and nothing is occluded. (The sheet
 * deliberately sets no dock padding: it is an overlay state entered on
 * purpose.) Same ambient semantics as the sheet: `role="complementary"`,
 * `z-40`, below every `z-50` modal surface, no modality machinery.
 *
 * @param props.content - The descriptor tucked away (supplies the title).
 * @param props.onRestore - Restore handler, wired to `restorePip`.
 * @param props.onClose - Close handler, wired to `closePip`.
 */
export function PipMiniBar({ content, onRestore, onClose }: PipMiniBarProps): React.ReactNode {
  // The occlusion fix: publish the dock height while the bar exists, remove it
  // the instant it goes away.
  React.useEffect(() => {
    document.documentElement.style.setProperty('--pip-dock', `${BAR_HEIGHT}px`);
    return () => {
      document.documentElement.style.removeProperty('--pip-dock');
    };
  }, []);

  // Keyboard-over-bar fix (DOR-300): the bar is fixed to the LAYOUT viewport,
  // but a phone's software keyboard shrinks only the VISUAL viewport, so at
  // `bottom: 0` the bar hides behind the keyboard exactly when the user types.
  // Lift it by the visual-viewport bottom inset — 0 when there's no keyboard, so
  // desktop and no-keyboard phones are unchanged. (`--pip-dock` stays 64px: that
  // is layout-viewport padding for the shells, a separate concern.)
  const keyboardInset = useVisualViewportBottomInset();

  return createPortal(
    <motion.div
      data-slot="pip-minibar"
      role="complementary"
      aria-label={content.title}
      initial={{ y: BAR_HEIGHT }}
      animate={{ y: 0 }}
      exit={{ y: BAR_HEIGHT }}
      transition={SPRING}
      style={{ bottom: keyboardInset }}
      className="bg-background border-border shadow-elevated fixed inset-x-0 bottom-0 z-40 flex h-16 items-center border-t"
    >
      <button
        type="button"
        onClick={onRestore}
        className="focus-ring flex h-full min-w-0 flex-1 items-center gap-3 px-4 text-left"
      >
        <span className="bg-primary size-2 shrink-0 animate-pulse rounded-full" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{content.title}</span>
        <ChevronUp className="text-muted-foreground size-4 shrink-0" />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-ring mr-3 shrink-0 rounded-md p-2 transition-colors"
      >
        <X className="size-4" />
      </button>
    </motion.div>,
    document.body
  );
}
