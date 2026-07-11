import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Info, RotateCcw, Undo2 } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useImageDiffReview } from '../model/use-image-diff-review';
import { Banner, ModeButton, DiffMessage, ArmedButton } from './diff-chrome';

interface CanvasImageDiffContentProps {
  /** Diff canvas content variant (an image path). */
  content: Extract<UiCanvasContent, { type: 'diff' }>;
}

/** The three GitHub-style image comparison modes. */
type ImageDiffMode = '2up' | 'swipe' | 'onion';

/** Load lifecycle for one image layer. */
type LayerState = 'loading' | 'loaded' | 'missing';

/**
 * The image diff review surface (DOR-212 Chunk B): GitHub-style 2-up, swipe,
 * and onion-skin comparison of an image's pre-edit baseline against its current
 * bytes, over two plain `<img>` layers — no new heavy dependency.
 *
 * Whole-file review: "Restore previous" writes the baseline bytes back to disk
 * through the server-held binary revert (confirm-gated — it discards the
 * agent's new image); "Mark reviewed" advances the baseline. A baseline that
 * doesn't exist (the agent created this image this session) degrades honestly:
 * the header says so and restore is not offered. Web-only — under a transport
 * that can't serve bytes by URL (Obsidian) a calm notice renders instead.
 */
export function CanvasImageDiffContent({ content }: CanvasImageDiffContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  const sessionId = useAppStore((s) => s.sessionId);
  const reduceMotion = useReducedMotion();

  const [mode, setMode] = useState<ImageDiffMode>('2up');
  const [baselineState, setBaselineState] = useState<LayerState>('loading');
  const [currentState, setCurrentState] = useState<LayerState>('loading');

  const review = useImageDiffReview({ cwd, sourcePath: content.sourcePath, sessionId });

  if (cwd === null || sessionId === null) {
    return <DiffMessage>Open a session to review changes.</DiffMessage>;
  }

  const baselineBase = transport.diffBaselineMediaUrl(cwd, content.sourcePath, sessionId);
  const currentBase = transport.mediaUrl(cwd, content.sourcePath);
  if (baselineBase === null || currentBase === null) {
    // The in-process transport has no URL surface for local bytes — image diff
    // is web-only, consistent with the shipped image viewer.
    return (
      <DiffMessage>
        Comparing image versions isn&rsquo;t available here. Open this session in the DorkOS web app
        to review image changes.
      </DiffMessage>
    );
  }

  // Cache-bust both layers on every refresh/restore so the browser refetches.
  const joiner = (base: string) => (base.includes('?') ? '&' : '?');
  const baselineUrl = `${baselineBase}${joiner(baselineBase)}v=${review.version}`;
  const currentUrl = `${currentBase}${joiner(currentBase)}v=${review.version}`;

  // 404 on the baseline layer = no previous version exists (a new image, or no
  // snapshot and not in git). Degrade honestly: comparison collapses to the
  // current image + a plain disclosure, and restore is not offered.
  const noBaseline = baselineState === 'missing';
  const currentMissing = currentState === 'missing';

  return (
    <div className="relative flex h-full flex-col">
      <div className="border-b">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {noBaseline ? 'New image' : 'Image changed'}
          </span>

          {!noBaseline && (
            <div className="flex items-center rounded-md border p-0.5">
              <ModeButton active={mode === '2up'} onClick={() => setMode('2up')}>
                2-up
              </ModeButton>
              <ModeButton active={mode === 'swipe'} onClick={() => setMode('swipe')}>
                Swipe
              </ModeButton>
              <ModeButton active={mode === 'onion'} onClick={() => setMode('onion')}>
                Onion skin
              </ModeButton>
            </div>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-7"
            aria-label="Refresh from disk"
            onClick={review.refresh}
          >
            <RotateCcw className="size-4" />
          </Button>

          {!noBaseline && (
            // Restoring the previous image discards the agent's new one — a
            // whole-file, content-independent write, so it is always
            // confirm-gated rather than hash-gated.
            <ArmedButton
              label="Restore previous"
              confirmLabel="Really restore?"
              ariaLabel="Restore the previous version of this image"
              confirmAriaLabel="Confirm: restore the previous version"
              icon={<Undo2 className="mr-1 size-3.5" />}
              requireConfirm
              disabled={review.writing}
              onConfirm={() => void review.restore()}
            />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7"
            onClick={() => void review.markReviewed()}
          >
            <Check className="mr-1 size-3.5" />
            Mark reviewed
          </Button>
        </div>

        {noBaseline && (
          <div className="text-muted-foreground flex items-start gap-1.5 px-3 pb-2 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              No previous version of this image from this session — there&rsquo;s nothing to
              restore.
            </span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {review.writeFailed && (
          <Banner key="write-failed" tone="error" reduceMotion={reduceMotion}>
            <span className="flex-1">
              That change couldn&rsquo;t be written to disk. Nothing was lost — try again.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={review.refresh}
            >
              Dismiss
            </Button>
          </Banner>
        )}
      </AnimatePresence>

      <div className="bg-muted/40 relative min-h-0 flex-1 overflow-auto p-4">
        {currentMissing ? (
          <DiffMessage>This image couldn&rsquo;t be loaded.</DiffMessage>
        ) : noBaseline ? (
          <SingleImage url={currentUrl} onState={setCurrentState} />
        ) : mode === '2up' ? (
          <TwoUp
            baselineUrl={baselineUrl}
            currentUrl={currentUrl}
            onBaselineState={setBaselineState}
            onCurrentState={setCurrentState}
          />
        ) : mode === 'swipe' ? (
          <Overlaid
            kind="swipe"
            baselineUrl={baselineUrl}
            currentUrl={currentUrl}
            onBaselineState={setBaselineState}
            onCurrentState={setCurrentState}
            reduceMotion={reduceMotion}
          />
        ) : (
          <Overlaid
            kind="onion"
            baselineUrl={baselineUrl}
            currentUrl={currentUrl}
            onBaselineState={setBaselineState}
            onCurrentState={setCurrentState}
            reduceMotion={reduceMotion}
          />
        )}
        {/* The baseline probe: when comparison is hidden (noBaseline) we still
            keep a zero-size probe mounted so a baseline that APPEARS (e.g.
            after a refresh) flips the state back. */}
        {noBaseline && (
          <img
            src={baselineUrl}
            alt=""
            aria-hidden
            className="hidden"
            onLoad={() => setBaselineState('loaded')}
            onError={() => setBaselineState('missing')}
          />
        )}
      </div>
    </div>
  );
}

/** One image layer with load/error reporting. */
function Layer({
  url,
  alt,
  className,
  onState,
}: {
  url: string;
  alt: string;
  className?: string;
  onState: (state: LayerState) => void;
}) {
  return (
    <img
      src={url}
      alt={alt}
      draggable={false}
      className={cn('select-none', className)}
      onLoad={() => onState('loaded')}
      onError={() => onState('missing')}
    />
  );
}

/** The lone current image when no baseline exists (a new image). */
function SingleImage({ url, onState }: { url: string; onState: (s: LayerState) => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Layer
        url={url}
        alt="Current image"
        onState={onState}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

/** Side-by-side before/after, stacking vertically on narrow panels. */
function TwoUp({
  baselineUrl,
  currentUrl,
  onBaselineState,
  onCurrentState,
}: {
  baselineUrl: string;
  currentUrl: string;
  onBaselineState: (s: LayerState) => void;
  onCurrentState: (s: LayerState) => void;
}) {
  return (
    <div className="flex h-full flex-col items-stretch justify-center gap-4 sm:flex-row">
      <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-1.5">
        <div className="flex min-h-0 w-full flex-1 items-center justify-center rounded-md border border-dashed p-2">
          <Layer
            url={baselineUrl}
            alt="Previous version"
            onState={onBaselineState}
            className="max-h-full max-w-full object-contain"
          />
        </div>
        <figcaption className="text-muted-foreground text-xs">Before</figcaption>
      </figure>
      <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-1.5">
        <div className="border-primary/40 flex min-h-0 w-full flex-1 items-center justify-center rounded-md border p-2">
          <Layer
            url={currentUrl}
            alt="Current version"
            onState={onCurrentState}
            className="max-h-full max-w-full object-contain"
          />
        </div>
        <figcaption className="text-muted-foreground text-xs">After</figcaption>
      </figure>
    </div>
  );
}

/**
 * The overlaid comparison modes. Both stack the current image exactly over the
 * baseline; `swipe` clips the top (current) layer at a draggable divider,
 * `onion` cross-fades it with an opacity slider.
 */
function Overlaid({
  kind,
  baselineUrl,
  currentUrl,
  onBaselineState,
  onCurrentState,
  reduceMotion,
}: {
  kind: 'swipe' | 'onion';
  baselineUrl: string;
  currentUrl: string;
  onBaselineState: (s: LayerState) => void;
  onCurrentState: (s: LayerState) => void;
  reduceMotion: boolean | null;
}) {
  // Swipe divider position / onion opacity, both 0–100.
  const [value, setValue] = useState(50);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const positionFromPointer = useCallback((clientX: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setValue(Math.min(100, Math.max(0, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (kind !== 'swipe') return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    positionFromPointer(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (kind !== 'swipe' || !dragging.current) return;
    positionFromPointer(e.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return (
    <div className="flex h-full flex-col items-center gap-3">
      <motion.div
        ref={stageRef}
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        className={cn(
          'relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-md border',
          kind === 'swipe' && 'touch-none'
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Bottom layer: the baseline (before). */}
        <Layer
          url={baselineUrl}
          alt="Previous version"
          onState={onBaselineState}
          className="max-h-full max-w-full object-contain"
        />
        {/* Top layer: the current image, positioned exactly over the baseline
            (same centering box), clipped or faded per mode. */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={
            kind === 'swipe' ? { clipPath: `inset(0 0 0 ${value}%)` } : { opacity: value / 100 }
          }
        >
          <Layer
            url={currentUrl}
            alt="Current version"
            onState={onCurrentState}
            className="max-h-full max-w-full object-contain"
          />
        </div>
        {kind === 'swipe' && (
          <div
            aria-hidden
            className="bg-primary/70 absolute inset-y-0 w-0.5 cursor-ew-resize"
            style={{ left: `${value}%` }}
          >
            <div className="bg-primary absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow" />
          </div>
        )}
      </motion.div>

      {kind === 'swipe' ? (
        <label className="text-muted-foreground flex w-full max-w-xs items-center gap-2 text-xs">
          <span className="sr-only">Swipe divider position</span>
          <span aria-hidden>Before</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(value)}
            onChange={(e) => setValue(Number(e.target.value))}
            className="accent-primary h-1 flex-1"
            aria-label="Swipe divider position"
          />
          <span aria-hidden>After</span>
        </label>
      ) : (
        <label className="text-muted-foreground flex w-full max-w-xs items-center gap-2 text-xs">
          <span className="sr-only">Blend between versions</span>
          <span aria-hidden>Before</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(value)}
            onChange={(e) => setValue(Number(e.target.value))}
            className="accent-primary h-1 flex-1"
            aria-label="Blend between the previous and current version"
          />
          <span aria-hidden>After</span>
        </label>
      )}
    </div>
  );
}
