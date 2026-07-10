import type { Options } from 'canvas-confetti';
import type { CelebrationKind } from '@dorkos/shared/types';

/**
 * The canvas-confetti instance type, derived from the lazy import so it matches
 * the module's own default-export type exactly (the published `CreateTypes`
 * interface disagrees with it on `reset`'s return type). Carries the callable
 * plus `reset`/`shapeFromText`.
 */
type Confetti = typeof import('canvas-confetti');

/**
 * The confetti firing engine — one lazy-loaded entry point, {@link fireCelebration},
 * that plays any of the {@link CelebrationKind} styles. Each style is tuned to
 * feel deliberate and expensive rather than a single flat pop; every style
 * originates from a caller-supplied point (so a celebration erupts from the
 * button that triggered it), honors `prefers-reduced-motion` (a no-op, never a
 * silent-but-running rAF loop), and returns a cleanup that cancels every pending
 * echo and interval it scheduled.
 *
 * @module shared/lib/celebrations/celebration-effects
 */

/** Normalized viewport coordinate (0–1 on each axis) canvas-confetti fires from. */
export interface CelebrationOrigin {
  x: number;
  y: number;
}

/** A no-op cleanup returned when nothing was scheduled (e.g. reduced motion). */
const NOOP = (): void => {};

/**
 * Where a celebration erupts when the caller supplies no origin — slightly
 * above screen-center so gravity carries particles down through the viewport.
 */
export const DEFAULT_CELEBRATION_ORIGIN: CelebrationOrigin = { x: 0.5, y: 0.62 };

/** The house gold — the DorkOS celebration identity, used by `burst`/`stars`/`rain`. */
const GOLD = ['#FFD700', '#FFC107', '#F7B500', '#FFFFFF'];

/** Per-kind color palettes. `emoji` carries its own glyph color, so its palette is unused. */
const PALETTES: Record<CelebrationKind, string[]> = {
  burst: GOLD,
  stars: ['#FFD700', '#FFC107', '#FFFFFF'],
  rain: ['#FFD700', '#FFE9A8', '#FFFFFF'],
  // Festive multi-hue for the big set-pieces.
  fireworks: ['#FFD700', '#FF5E5B', '#4ECDC4', '#5D9CEC', '#C77DFF', '#FFFFFF'],
  cannons: ['#FFD700', '#4ECDC4', '#FF5E5B', '#FFFFFF'],
  emoji: GOLD,
};

/** The glyph the `emoji` kind throws when the command omits one. */
const DEFAULT_EMOJI = '🎉';

/** Clamp a normalized coordinate to the valid 0–1 range. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Convert a DOM element's bounding rect into the normalized viewport origin
 * canvas-confetti expects — the center of the rect, as a 0–1 fraction of the
 * viewport. Pure and framework-free so a click site can compute where a
 * celebration should erupt from without importing the engine's internals.
 *
 * @param rect - The triggering element's bounding rectangle (viewport-relative).
 * @param viewport - The viewport size; defaults to the current window.
 */
export function rectToCelebrationOrigin(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  }
): CelebrationOrigin {
  return {
    x: clamp01((rect.left + rect.width / 2) / viewport.width),
    y: clamp01((rect.top + rect.height / 2) / viewport.height),
  };
}

/** Whether the viewer has asked for reduced motion — celebrations become no-ops. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** A random float in `[min, max)` — the jitter that keeps fireworks/rain from looking mechanical. */
function randomInRange(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Tracks every timer a celebration schedules so cleanup can cancel them all.
 * Timeout and interval ids share the numeric handle space in the browser, so a
 * single set plus a clear-both cleanup is safe and simple.
 */
class TimerBag {
  private readonly handles = new Set<ReturnType<typeof setTimeout>>();

  /** Run `fn` once after `ms`, tracked so a mid-flight cleanup cancels it. */
  after(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.handles.delete(id);
      fn();
    }, ms);
    this.handles.add(id);
  }

  /** Run `fn` every `stepMs` for `durationMs`, then stop. Tracked for cleanup. */
  every(stepMs: number, durationMs: number, fn: () => void): void {
    const start = Date.now();
    const id = setInterval(() => {
      if (Date.now() - start >= durationMs) {
        clearInterval(id);
        this.handles.delete(id);
        return;
      }
      fn();
    }, stepMs);
    this.handles.add(id);
  }

  /** Cancel every scheduled timer and interval. */
  clear(): void {
    for (const id of this.handles) {
      clearTimeout(id);
      clearInterval(id);
    }
    this.handles.clear();
  }
}

/** Shared base every fire call inherits — reduced-motion is belt-and-suspenders with the top gate. */
const BASE: Options = { disableForReducedMotion: true, ticks: 200 };

/** A proper multi-stage pop from the origin: a dense core, a wide halo, and a delayed echo. */
function fireBurst(
  confetti: Confetti,
  origin: CelebrationOrigin,
  colors: string[],
  particleCount: number,
  bag: TimerBag
): void {
  const base = { ...BASE, origin, colors, gravity: 1.1 };
  confetti({ ...base, particleCount, spread: 78, startVelocity: 46, scalar: 1.05 });
  confetti({
    ...base,
    particleCount: Math.round(particleCount * 0.6),
    spread: 120,
    startVelocity: 30,
    scalar: 0.75,
    decay: 0.92,
  });
  bag.after(130, () =>
    confetti({
      ...base,
      particleCount: Math.round(particleCount * 0.5),
      spread: 100,
      startVelocity: 40,
      scalar: 1.25,
    })
  );
}

/** Golden star-shaped burst — the "gold star" moment for a job well done. */
function fireStars(
  confetti: Confetti,
  origin: CelebrationOrigin,
  colors: string[],
  bag: TimerBag
): void {
  const base = { ...BASE, origin, colors, shapes: ['star'] as Options['shapes'], gravity: 0.9 };
  confetti({ ...base, particleCount: 40, spread: 90, startVelocity: 40, scalar: 1.25 });
  bag.after(140, () =>
    confetti({ ...base, particleCount: 22, spread: 120, startVelocity: 28, scalar: 0.95 })
  );
}

/** ~2.5s of randomized aerial shells bursting across the top half of the screen. */
function fireFireworks(confetti: Confetti, colors: string[], bag: TimerBag): void {
  bag.every(240, 2500, () => {
    confetti({
      ...BASE,
      particleCount: 42,
      spread: 360,
      startVelocity: 30,
      ticks: 90,
      gravity: 1,
      scalar: randomInRange(0.8, 1.3),
      colors,
      origin: { x: randomInRange(0.15, 0.85), y: randomInRange(0.1, 0.5) },
    });
  });
}

/** Side cannons crossfiring from the screen edges toward center for ~1.2s. */
function fireCannons(confetti: Confetti, colors: string[], bag: TimerBag): void {
  const shot = { ...BASE, particleCount: 14, spread: 58, startVelocity: 58, colors, scalar: 1.05 };
  bag.every(180, 1200, () => {
    confetti({ ...shot, angle: 60, origin: { x: 0, y: 0.68 } });
    confetti({ ...shot, angle: 120, origin: { x: 1, y: 0.68 } });
  });
}

/** An emoji-particle burst from the origin using a text-derived shape. */
function fireEmoji(
  confetti: Confetti,
  origin: CelebrationOrigin,
  emoji: string,
  bag: TimerBag
): void {
  // Emoji scalar and shape scalar must agree or the glyph renders at the wrong size.
  const shape = confetti.shapeFromText({ text: emoji, scalar: 2.2 });
  const base = { ...BASE, origin, shapes: [shape], scalar: 2.2, gravity: 1, flat: true } as Options;
  confetti({ ...base, particleCount: 26, spread: 90, startVelocity: 44 });
  bag.after(120, () => confetti({ ...base, particleCount: 16, spread: 120, startVelocity: 30 }));
}

/** A calm ~2s drizzle of confetti sifting down from above the top edge. */
function fireRain(confetti: Confetti, colors: string[], bag: TimerBag): void {
  bag.every(120, 2000, () => {
    confetti({
      ...BASE,
      particleCount: 4,
      angle: 90,
      spread: 180,
      startVelocity: 12,
      gravity: 0.6,
      scalar: 0.9,
      drift: randomInRange(-0.6, 0.6),
      colors,
      origin: { x: randomInRange(0, 1), y: -0.1 },
    });
  });
}

/**
 * Fire a celebration. Lazy-loads canvas-confetti on first call, plays the
 * requested {@link CelebrationKind} (default `burst`), and returns a cleanup
 * that cancels every echo/interval the style scheduled and resets the canvas.
 *
 * A no-op under `prefers-reduced-motion` — it does not even load the library or
 * start a timer, so there is never a running-but-invisible animation.
 *
 * @param options - Style, origin, glyph, and optional palette/particle overrides.
 * @param options.kind - Which celebration to play; defaults to `burst`.
 * @param options.origin - Normalized viewport point to erupt from; defaults to
 *   {@link DEFAULT_CELEBRATION_ORIGIN}. Ignored by ambient kinds (fireworks,
 *   cannons, rain) that own the whole viewport.
 * @param options.emoji - Glyph for the `emoji` kind; defaults to 🎉.
 * @param options.colors - Palette override; defaults to the kind's palette.
 * @param options.particleCount - Density override for `burst`'s core stage.
 */
export async function fireCelebration(options?: {
  kind?: CelebrationKind;
  origin?: CelebrationOrigin;
  emoji?: string;
  colors?: string[];
  particleCount?: number;
}): Promise<() => void> {
  if (prefersReducedMotion()) return NOOP;

  const confetti = (await import('canvas-confetti')).default;
  const kind = options?.kind ?? 'burst';
  const origin = options?.origin ?? DEFAULT_CELEBRATION_ORIGIN;
  const colors = options?.colors ?? PALETTES[kind];
  const bag = new TimerBag();

  switch (kind) {
    case 'burst':
      fireBurst(confetti, origin, colors, options?.particleCount ?? 60, bag);
      break;
    case 'stars':
      fireStars(confetti, origin, colors, bag);
      break;
    case 'fireworks':
      fireFireworks(confetti, colors, bag);
      break;
    case 'cannons':
      fireCannons(confetti, colors, bag);
      break;
    case 'emoji':
      fireEmoji(confetti, origin, options?.emoji || DEFAULT_EMOJI, bag);
      break;
    case 'rain':
      fireRain(confetti, colors, bag);
      break;
  }

  return () => {
    bag.clear();
    confetti.reset();
  };
}
