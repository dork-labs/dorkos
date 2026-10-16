/**
 * The viewer: one picture at a time over a frosted page, grown out of the
 * thumbnail that opened it and shrunk back into it on close.
 *
 * Fetched only when somebody first opens a picture — see
 * `image-lightbox-group.tsx`, which is the piece hosts actually render.
 *
 * Everything a reader can do, and how:
 *
 * | Do              | Pointer                    | Touch                   | Keys        |
 * | --------------- | -------------------------- | ----------------------- | ----------- |
 * | Close           | click outside the picture  | drag down               | Escape      |
 * | Next / previous | the side arrows            | drag sideways           | ← →         |
 * | Zoom            | scroll, or double-click    | pinch, or double-tap    | —           |
 * | Save            | the download button        | the download button     | Tab, Enter  |
 *
 * It is a modal (Radix Dialog underneath): focus stays inside while it is open
 * and goes back to the thumbnail of the picture showing when it closes.
 *
 * @module shared/ui/image-lightbox/image-lightbox
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Spinner } from '../spinner';
import { flipFromThumbnail } from './flip';
import { downloadLightboxImage, type LightboxImage } from './lightbox-image';
import { SETTLE, useLightboxGestures } from './use-lightbox-gestures';

/** Props for {@link ImageLightbox}. */
export interface ImageLightboxProps {
  /** Whether the viewer is showing. */
  open: boolean;
  /** Called with `false` once the close animation has finished. */
  onOpenChange?: (open: boolean) => void;
  /** Every picture in the gallery, in reading order. */
  images: readonly LightboxImage[];
  /** Which of them is showing. */
  index: number;
  /** Called when the reader steps to another picture. */
  onIndexChange: (index: number) => void;
  /**
   * The thumbnail button for a picture: where it grows from, where it shrinks
   * back to, and where focus returns on close.
   */
  getTrigger?: (index: number) => HTMLElement | null;
}

/** How the picture moves into place, and back. */
const GROW = { type: 'spring', stiffness: 360, damping: 34, mass: 0.9 } as const;
const SHRINK = { type: 'spring', stiffness: 420, damping: 40 } as const;
const FADE = { duration: 0.16, ease: 'easeOut' } as const;
/** How far a picture slides when the reader steps to the next one. */
const STEP_PX = 72;

/** Stops one event from reaching the React tree around the viewer. */
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * The bubbling events a message row (or the list around it) acts on: its
 * right-click menu, its long press, its keyboard navigation.
 *
 * React's `stopPropagation` stops the browser's event too, so this list is kept
 * to what a row needs and no more. Mouse events are left out because the zoom
 * surface pans from `window`-level mouse listeners; focus events are left out
 * because Radix's focus trap listens for them on `document`.
 */
const STOP_AT_VIEWER = {
  onClick: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
  onKeyDown: stop,
  onKeyUp: stop,
  onPointerDown: stop,
  onPointerMove: stop,
  onPointerUp: stop,
  onPointerCancel: stop,
  onTouchStart: stop,
  onTouchMove: stop,
  onTouchEnd: stop,
  onWheel: stop,
};

/** What the viewer is in the middle of; gestures and keys wait while it moves. */
type Phase = 'idle' | 'stepping' | 'closing';

/** Whether each picture has loaded, failed, or neither yet. */
type LoadState = 'loading' | 'loaded' | 'error';

/** The full-screen picture viewer behind every thumbnail in a message. */
export function ImageLightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  getTrigger,
}: ImageLightboxProps) {
  const reduceMotion = useReducedMotion() === true;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const opacity = useMotionValue(1);
  const backdrop = useMotionValue(0);
  // The buttons and caption fade a little ahead of the backdrop, so a drag
  // down clears them out of the way of the picture first.
  const chrome = useTransform(backdrop, [0.55, 1], [0, 1]);

  const stageRef = useRef<HTMLDivElement>(null);
  const phase = useRef<Phase>('idle');
  // Escape pressed while a picture slides in is honoured once it lands.
  const closeAfterStep = useRef(false);
  const closeRef = useRef<() => Promise<void>>(async () => {});
  const stepDirection = useRef<1 | -1 | null>(null);
  // Which picture is zoomed in, if any. Keyed by picture, so stepping to the
  // next one (a fresh zoom surface, at 1x) is never mistaken for zoomed.
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const [load, setLoad] = useState<Record<string, LoadState>>({});

  const current = images[index];
  const count = images.length;
  const status: LoadState = current ? (load[current.src] ?? 'loading') : 'loading';
  const zoomed = current !== undefined && zoomedSrc === current.src;

  // Grow out of the thumbnail on open. A layout effect, so the first frame the
  // reader sees is already the picture sitting over its thumbnail.
  useLayoutEffect(() => {
    if (!open) return;
    phase.current = 'idle';
    closeAfterStep.current = false;
    stepDirection.current = null;
    x.set(0);
    y.set(0);
    scale.set(1);
    void animate(backdrop, 1, reduceMotion ? FADE : { duration: 0.24, ease: 'easeOut' });
    const thumb = getTrigger?.(index)?.querySelector('img');
    const stage = stageRef.current?.getBoundingClientRect();
    const from =
      !reduceMotion && thumb && stage
        ? flipFromThumbnail(thumb, stage, { width: window.innerWidth, height: window.innerHeight })
        : null;
    if (from) {
      x.set(from.x);
      y.set(from.y);
      scale.set(from.scale);
      opacity.set(1);
      void animate(x, 0, GROW);
      void animate(y, 0, GROW);
      void animate(scale, 1, GROW);
    } else {
      opacity.set(0);
      if (!reduceMotion) scale.set(0.96);
      void animate(opacity, 1, FADE);
      void animate(scale, 1, FADE);
    }
    // Only an open starts this; stepping between pictures has its own motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Slide the next picture in from the side it was asked for.
  useLayoutEffect(() => {
    const direction = stepDirection.current;
    if (direction === null) return;
    stepDirection.current = null;
    y.set(0);
    scale.set(1);
    x.set(reduceMotion ? 0 : direction * STEP_PX);
    void animate(x, 0, SETTLE);
    void animate(opacity, 1, FADE).then(() => {
      phase.current = 'idle';
      if (closeAfterStep.current) {
        closeAfterStep.current = false;
        void closeRef.current();
      }
    });
  }, [index, opacity, reduceMotion, x, y, scale]);

  // Fetch the neighbours now, so stepping to one shows it at once.
  useEffect(() => {
    if (!open) return;
    for (const neighbour of [images[index - 1], images[index + 1]]) {
      if (neighbour) new Image().src = neighbour.src;
    }
  }, [open, images, index]);

  const close = useCallback(async () => {
    if (phase.current === 'closing') return;
    if (phase.current === 'stepping') {
      closeAfterStep.current = true;
      return;
    }
    phase.current = 'closing';
    setZoomedSrc(null);
    const thumb = getTrigger?.(index)?.querySelector('img');
    const stage = stageRef.current?.getBoundingClientRect();
    const to =
      !reduceMotion && !zoomed && thumb && stage
        ? flipFromThumbnail(thumb, stage, { width: window.innerWidth, height: window.innerHeight })
        : null;
    const fadeOut = animate(backdrop, 0, reduceMotion ? FADE : { duration: 0.22, ease: 'easeIn' });
    if (to) {
      await Promise.all([
        animate(x, to.x, SHRINK),
        animate(y, to.y, SHRINK),
        animate(scale, to.scale, SHRINK),
        fadeOut,
      ]);
    } else {
      await Promise.all([
        animate(opacity, 0, FADE),
        reduceMotion ? null : animate(scale, scale.get() * 0.96, FADE),
        fadeOut,
      ]);
    }
    onOpenChange?.(false);
  }, [backdrop, getTrigger, index, onOpenChange, opacity, reduceMotion, scale, x, y, zoomed]);
  useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);

  const step = useCallback(
    async (direction: 1 | -1) => {
      const next = index + direction;
      if (phase.current !== 'idle' || next < 0 || next >= count) return;
      phase.current = 'stepping';
      await Promise.all([
        reduceMotion ? null : animate(x, -direction * STEP_PX + x.get() * 0.5, FADE),
        animate(opacity, 0, { duration: 0.1 }),
      ]);
      stepDirection.current = direction;
      onIndexChange(next);
    },
    [count, index, onIndexChange, opacity, reduceMotion, x]
  );

  const gestures = useLightboxGestures({
    x,
    y,
    scale,
    backdrop,
    canGesture: () => phase.current === 'idle' && !zoomed,
    canStep: (direction) => index + direction >= 0 && index + direction < count,
    onDismiss: () => void close(),
    onStep: (direction) => void step(direction),
  });

  if (!current) return null;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      {/* An explicit container renders in the same commit as the open, so the
          grow-from-the-thumbnail measure below finds the stage on its first run.
          Left to itself the portal waits a render for `document.body`. */}
      <DialogPrimitive.Portal container={document.body}>
        {/* A portal moves the DOM, not the React tree: events still bubble to
            the message row the gallery lives in, whose right-click menu,
            long-press drawer and arrow-key navigation would all answer a
            gesture made in here. They stop at this wrapper. */}
        <div className="contents" {...STOP_AT_VIEWER}>
          <DialogPrimitive.Overlay asChild>
            <motion.div
              data-slot="image-lightbox-backdrop"
              style={{ opacity: backdrop }}
              className="bg-background/90 fixed inset-0 z-50 backdrop-blur-xl"
            />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content
            data-slot="image-lightbox"
            aria-describedby={undefined}
            // The surface itself takes focus, so the arrow keys work at once and no
            // button wears a focus ring the reader did not ask for.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            // Focus pulled away by the page (a composer that focuses itself, a
            // window switch) is not the reader closing the picture; the focus
            // trap brings it back instead.
            onFocusOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              const trigger = getTrigger?.(index);
              if (!trigger) return;
              event.preventDefault();
              trigger.focus({ preventScroll: true });
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') void step(1);
              else if (event.key === 'ArrowLeft') void step(-1);
            }}
            onClick={(event) => {
              // Anywhere that is not the picture or a button is "outside it".
              // Measured, not read off the target: the zoom surface turns
              // pointer events off on the picture, so a click on it lands on
              // the surface behind it.
              const target = event.target as HTMLElement;
              if (gestures.endedDrag() || target.closest('button')) return;
              const picture = stageRef.current?.querySelector('img')?.getBoundingClientRect();
              const onPicture =
                picture !== undefined &&
                event.clientX >= picture.left &&
                event.clientX <= picture.right &&
                event.clientY >= picture.top &&
                event.clientY <= picture.bottom;
              if (!onPicture) void close();
            }}
            {...gestures.handlers}
            className="fixed inset-0 z-50 flex touch-none flex-col outline-none select-none"
          >
            <DialogPrimitive.Title className="sr-only">
              {current.alt || 'Image'}
            </DialogPrimitive.Title>

            <motion.div
              style={{ opacity: chrome }}
              className="flex shrink-0 items-center justify-between gap-2 pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-2 pl-[max(0.75rem,env(safe-area-inset-left))]"
            >
              <p
                aria-live="polite"
                className={cn(
                  'text-muted-foreground px-2 text-sm tabular-nums',
                  count < 2 && 'invisible'
                )}
              >
                {index + 1} of {count}
              </p>
              <div className="flex items-center gap-2">
                <ChromeButton
                  label="Download image"
                  onClick={() => void downloadLightboxImage(current)}
                >
                  <Download className="size-[18px]" />
                </ChromeButton>
                <ChromeButton label="Close" onClick={() => void close()}>
                  <X className="size-5" />
                </ChromeButton>
              </div>
            </motion.div>

            <div className="relative min-h-0 flex-1 px-3 sm:px-20">
              <div ref={stageRef} className="relative h-full w-full">
                <motion.div style={{ x, y, scale, opacity }} className="h-full w-full">
                  <TransformWrapper
                    key={current.src}
                    centerOnInit
                    minScale={1}
                    maxScale={8}
                    doubleClick={{ mode: 'toggle', step: 1.2 }}
                    wheel={{ step: 0.15 }}
                    panning={{ disabled: !zoomed, velocityDisabled: true }}
                    onTransform={(_, state) =>
                      setZoomedSrc(state.scale > 1.01 ? current.src : null)
                    }
                  >
                    <TransformComponent
                      wrapperClass="!h-full !w-full"
                      contentClass="!h-full !w-full flex items-center justify-center"
                    >
                      {status === 'error' ? (
                        <p className="text-muted-foreground flex items-center gap-2 text-sm">
                          <ImageOff aria-hidden className="size-4" />
                          This image couldn’t be loaded.
                        </p>
                      ) : (
                        <img
                          src={current.src}
                          alt={current.alt}
                          draggable={false}
                          onLoad={() => setLoad((s) => ({ ...s, [current.src]: 'loaded' }))}
                          onError={() => setLoad((s) => ({ ...s, [current.src]: 'error' }))}
                          className={cn(
                            'max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-black/25',
                            zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
                          )}
                        />
                      )}
                    </TransformComponent>
                  </TransformWrapper>
                </motion.div>
                {status === 'loading' && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <Spinner size="md" label="Loading image" className="text-muted-foreground" />
                  </div>
                )}
              </div>

              {index > 0 && (
                <StepButton direction={-1} fade={chrome} onClick={() => void step(-1)} />
              )}
              {index < count - 1 && (
                <StepButton direction={1} fade={chrome} onClick={() => void step(1)} />
              )}
            </div>

            <motion.div
              style={{ opacity: chrome }}
              className="flex min-h-12 shrink-0 items-center justify-center px-6 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              {current.alt && (
                <p className="text-muted-foreground line-clamp-2 max-w-prose text-center text-sm">
                  {current.alt}
                </p>
              )}
            </motion.div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A round, frosted control floating over the picture. */
function ChromeButton({
  label,
  onClick,
  fade,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  /** Fades the button with the backdrop while a drag down is closing the viewer. */
  fade?: MotionValue<number>;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={fade ? { opacity: fade } : undefined}
      className={cn(
        'focus-ring bg-background/70 text-foreground border-border/60 hover:bg-background',
        'flex size-10 items-center justify-center rounded-full border shadow-sm backdrop-blur-md',
        'transition-colors duration-150 motion-reduce:transition-none',
        className
      )}
    >
      {children}
    </motion.button>
  );
}

/** The previous or next arrow at the side of the stage, from tablet width up. */
function StepButton({
  direction,
  fade,
  onClick,
}: {
  direction: 1 | -1;
  fade: MotionValue<number>;
  onClick: () => void;
}) {
  return (
    <ChromeButton
      label={direction === 1 ? 'Next image' : 'Previous image'}
      onClick={onClick}
      fade={fade}
      className={cn(
        'absolute top-1/2 hidden -translate-y-1/2 sm:flex',
        direction === 1 ? 'right-4' : 'left-4'
      )}
    >
      {direction === 1 ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}
    </ChromeButton>
  );
}
