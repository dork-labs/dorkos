import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, useAnimationControls, useDragControls, type PanInfo } from 'motion/react';
import { ChevronDown, X } from 'lucide-react';
import type { PipContent } from '@/layers/shared/model';

/**
 * Snap positions as fractions of the viewport height: `peek` (half screen —
 * enough to show a full tic-tac-toe board on a typical phone) and `expanded`
 * (comfortable play). The sheet always opens at peek and never persists snap
 * state (geometry persistence is desktop-only, per the spec's Non-Goals).
 */
const SNAP_POINTS = { peek: 0.5, expanded: 0.94 } as const;

type Snap = keyof typeof SNAP_POINTS;

/** Dragged this far below peek (fraction of the peek height), release minimizes. */
const MINIMIZE_DRAG_FRACTION = 0.4;

/** Downward release velocity (px/s) that minimizes when released below peek. */
const MINIMIZE_VELOCITY = 800;

/** Release velocity (px/s) beyond which the flick direction picks the snap. */
const FLICK_VELOCITY = 500;

/** Calm-Tech feel: a firm spring that settles in ~200ms without wobble. */
const SPRING = { type: 'spring', stiffness: 480, damping: 44 } as const;

interface PipSheetProps {
  /** The descriptor to present. Non-null: the host only mounts the sheet while open. */
  content: PipContent;
  /** Wired to `closePip`. The X button is the only close. */
  onClose: () => void;
  /**
   * Wired to `minimizePip` (Amendment 2). Fired by the header's chevron and by
   * a drag released clearly below peek — the most casual gesture takes the
   * least destructive path (mini-bar, not close).
   */
  onMinimize: () => void;
  /** `renderPipContent(content)` output — the live widget or MCP app frame. */
  children: React.ReactNode;
}

/**
 * Mobile PIP presenter: the same serializable {@link PipContent} descriptor the
 * desktop `FloatingPanel` shows, docked instead into a non-modal snap-point
 * bottom sheet below 768px. Opens at the peek snap and drags up to expand.
 *
 * Cockpit-native by decision (spec Amendment 1): a plain `motion.div` portalled
 * to `document.body` with `role="complementary"` — the exact semantics of
 * `FloatingPanel` — and **no** dialog/portal-modality machinery. vaul was
 * rejected at the validation gate because it never forwards `modal` to its
 * Radix Dialog, which `aria-hidden`s the entire app behind a supposedly
 * non-modal sheet. Here there is nothing to un-hide and nothing to lock: the
 * app behind the sheet stays interactive, undimmed, and visible to assistive
 * technology. It sits at `z-40`, the same tier as the desktop panel and
 * deliberately below every `z-50` modal surface, so PIP never covers a modal.
 *
 * Snap model: the container is sized to the expanded snap and animated on `y`
 * (expanded → 0, peek → the fraction gap). Drag starts only from the
 * handle/header region (`dragListener={false}` + drag controls), so the content
 * region scrolls and taps freely — an embedded iframe never fights the sheet.
 * Release resolves by offset + velocity to the nearest snap, or MINIMIZES when
 * released clearly below peek (Amendment 2): the casual put-it-away gesture
 * tucks PIP into the mini-bar with the content still set and live, never
 * closing it. The header's X is the only close — safe either way under the
 * dual-live model, since the inline instance still lives in the transcript.
 *
 * @param props.content - The descriptor to present (supplies the sheet title).
 * @param props.onClose - Close handler, wired to `closePip`.
 * @param props.onMinimize - Minimize handler, wired to `minimizePip`.
 * @param props.children - The rendered content body.
 */
export function PipSheet({
  content,
  onClose,
  onMinimize,
  children,
}: PipSheetProps): React.ReactNode {
  const dragControls = useDragControls();
  // Imperative animation controls, not the declarative `animate` prop: a drag
  // mutates the y MotionValue without touching any target, so after a release
  // that resolves to the SAME snap a re-render is a no-op (unchanged target ⇒
  // motion skips the animation) and the sheet would stick mid-offset. Every
  // settle is therefore an explicit `controls.start`.
  const controls = useAnimationControls();
  // Snap state is component-local and intentionally resets to peek on every
  // open (no persistence, per the spec's Non-Goals).
  const [snap, setSnap] = React.useState<Snap>('peek');
  // Tracked in state so snap offsets recompute while open (rotation, keyboard,
  // browser chrome), mirroring how FloatingPanel reclamps on window resize.
  const [viewportHeight, setViewportHeight] = React.useState(() => window.innerHeight);

  React.useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const sheetHeight = SNAP_POINTS.expanded * viewportHeight;
  const peekY = (SNAP_POINTS.expanded - SNAP_POINTS.peek) * viewportHeight;
  const targetY = snap === 'expanded' ? 0 : peekY;

  // Drive y to the current snap target: on mount (the entry animation from the
  // offscreen `initial`), on snap change, and on viewport resize (peekY moved).
  React.useEffect(() => {
    void controls.start({ y: targetY, transition: SPRING });
  }, [controls, targetY]);

  const handleDragEnd = (_event: PointerEvent, info: PanInfo) => {
    const releasedY = targetY + info.offset.y;
    const velocity = info.velocity.y;
    const belowPeek = releasedY - peekY;
    // Released clearly below peek: far past it, or past it at all with a
    // strong downward flick. The gesture reads as "put it away" — minimize to
    // the mini-bar (Amendment 2), never close.
    const peekHeight = SNAP_POINTS.peek * viewportHeight;
    if (
      belowPeek > MINIMIZE_DRAG_FRACTION * peekHeight ||
      (belowPeek > 0 && velocity > MINIMIZE_VELOCITY)
    ) {
      onMinimize();
      return;
    }
    let next: Snap;
    if (velocity < -FLICK_VELOCITY) next = 'expanded';
    else if (velocity > FLICK_VELOCITY) next = 'peek';
    else next = releasedY < peekY / 2 ? 'expanded' : 'peek';
    // Same snap: the settle effect won't fire (target unchanged), so spring
    // back explicitly. Different snap: setSnap changes targetY and the effect
    // runs the one animation.
    if (next === snap) {
      void controls.start({ y: targetY, transition: SPRING });
    } else {
      setSnap(next);
    }
  };

  const startDrag = (event: React.PointerEvent) => {
    // Let clicks on the close control behave as a button, not a drag start
    // (same guard as FloatingPanel's header).
    if ((event.target as HTMLElement).closest('button')) return;
    dragControls.start(event);
  };

  return createPortal(
    <motion.div
      data-slot="pip-sheet"
      role="complementary"
      aria-label={content.title}
      initial={{ y: sheetHeight }}
      animate={controls}
      exit={{ y: sheetHeight }}
      // The settle effect/onDragEnd supply their own transition; this one is
      // for the AnimatePresence exit (slide down offscreen).
      transition={SPRING}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: sheetHeight }}
      dragElastic={0.1}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      style={{ height: sheetHeight }}
      className="bg-background border-border shadow-modal fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-lg border-t"
    >
      {/* Handle + header form the sole drag surface; everything below scrolls. */}
      <div
        onPointerDown={startDrag}
        className="cursor-grab touch-none select-none active:cursor-grabbing"
      >
        <div className="bg-muted mx-auto mt-4 h-2 w-[100px] rounded-full" />
        <div className="flex items-center justify-between gap-2 border-b px-4 pt-1 pb-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{content.title}</span>
          <button
            type="button"
            aria-label="Minimize"
            onClick={onMinimize}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-ring shrink-0 rounded-md p-1 transition-colors"
          >
            <ChevronDown className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-ring shrink-0 rounded-md p-1 transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </motion.div>,
    document.body
  );
}
