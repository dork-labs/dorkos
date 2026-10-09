import type { Options } from 'canvas-confetti';
import type { CelebrationKind } from '@dorkos/shared/types';
import type { EffectOwner } from '../extension-effect-owner';
import { TimerBag } from './celebration-timers';

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

/**
 * Where a celebration erupts when the caller supplies no origin — slightly
 * above screen-center so gravity carries particles down through the viewport.
 */
export const DEFAULT_CELEBRATION_ORIGIN: CelebrationOrigin = {
  x: 0.5,
  y: 0.62,
};

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

type Fire = ((options: Options) => ReturnType<Confetti>) & {
  /** The owned emoji style uses only canvas-confetti's object overload. */
  shapeFromText: (
    ...args: Parameters<Confetti['shapeFromText']>
  ) => ReturnType<Confetti['shapeFromText']>;
};

/** Shared base every fire call inherits — reduced-motion is belt-and-suspenders with the top gate. */
const BASE: Options = { disableForReducedMotion: true, ticks: 200 };

/** A proper multi-stage pop from the origin: a dense core, a wide halo, and a delayed echo. */
function fireBurst(
  confetti: Fire,
  origin: CelebrationOrigin,
  input: { colors: string[]; particleCount: number; bag: TimerBag }
): void {
  const { colors, particleCount, bag } = input;
  const base = { ...BASE, origin, colors, gravity: 1.1 };
  confetti({
    ...base,
    particleCount,
    spread: 78,
    startVelocity: 46,
    scalar: 1.05,
  });
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
  confetti: Fire,
  origin: CelebrationOrigin,
  colors: string[],
  bag: TimerBag
): void {
  const base = {
    ...BASE,
    origin,
    colors,
    shapes: ['star'] as Options['shapes'],
    gravity: 0.9,
  };
  confetti({
    ...base,
    particleCount: 40,
    spread: 90,
    startVelocity: 40,
    scalar: 1.25,
  });
  bag.after(140, () =>
    confetti({
      ...base,
      particleCount: 22,
      spread: 120,
      startVelocity: 28,
      scalar: 0.95,
    })
  );
}

/** ~2.5s of randomized aerial shells bursting across the top half of the screen. */
function fireFireworks(confetti: Fire, colors: string[], bag: TimerBag): void {
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
function fireCannons(confetti: Fire, colors: string[], bag: TimerBag): void {
  const shot = {
    ...BASE,
    particleCount: 14,
    spread: 58,
    startVelocity: 58,
    colors,
    scalar: 1.05,
  };
  bag.every(180, 1200, () => {
    confetti({ ...shot, angle: 60, origin: { x: 0, y: 0.68 } });
    confetti({ ...shot, angle: 120, origin: { x: 1, y: 0.68 } });
  });
}

/** An emoji-particle burst from the origin using a text-derived shape. */
function fireEmoji(confetti: Fire, origin: CelebrationOrigin, emoji: string, bag: TimerBag): void {
  // Emoji scalar and shape scalar must agree or the glyph renders at the wrong size.
  const shape = confetti.shapeFromText({ text: emoji, scalar: 2.2 });
  const base = {
    ...BASE,
    origin,
    shapes: [shape],
    scalar: 2.2,
    gravity: 1,
    flat: true,
  } as Options;
  confetti({ ...base, particleCount: 26, spread: 90, startVelocity: 44 });
  bag.after(120, () => confetti({ ...base, particleCount: 16, spread: 120, startVelocity: 30 }));
}

/** A calm ~2s drizzle of confetti sifting down from above the top edge. */
function fireRain(confetti: Fire, colors: string[], bag: TimerBag): void {
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
 * @param owner - Optional originating extension occurrence and retained cancellation.
 */
export async function fireCelebration(
  options?: {
    kind?: CelebrationKind;
    origin?: CelebrationOrigin;
    emoji?: string;
    colors?: string[];
    particleCount?: number;
  },
  owner?: EffectOwner
): Promise<() => void> {
  const custody = createCelebrationCustody(owner);
  const { bag, cancel, requireCurrent } = custody;
  try {
    const reduced = prefersReducedMotion();
    requireCurrent();
    if (reduced) {
      custody.finished();
      return cancel;
    }
    const loaded = await import('canvas-confetti');
    requireCurrent();
    const confetti = loaded.default;
    const kind = options?.kind ?? 'burst';
    const suppliedOrigin = options?.origin ?? DEFAULT_CELEBRATION_ORIGIN;
    const origin = { x: suppliedOrigin.x, y: suppliedOrigin.y };
    const colors = options?.colors ?? PALETTES[kind];
    const count = options?.particleCount ?? 60;
    const emoji = options?.emoji || DEFAULT_EMOJI;
    // No options or origin accessor remains behind the final entry guard.
    let producer: (options: Options) => ReturnType<Confetti> = confetti;
    if (owner) {
      const create = confetti.create;
      const input = { resize: true, useWorker: false };
      requireCurrent();
      const original = Reflect.apply(create, confetti, [undefined, input]);
      const reset = original.reset;
      custody.setReset(() => Reflect.apply(reset, original, []));
      producer = original;
    }
    const fire = createOwnedFire(
      confetti,
      producer,
      requireCurrent,
      custody.animation,
      custody.perform
    );
    requireCurrent();
    runCelebrationStyle({ kind, fire, origin, colors, count, emoji, bag });
    custody.finished();
    if (owner) return cancel;
    // Preserve the existing nonextension returned-cleanup contract.
    return () => {
      cancel();
      const reset = confetti.reset;
      Reflect.apply(reset, confetti, []);
    };
  } catch (error) {
    custody.failed(error);
    // Preserve the first ordinary failure; installed cleanup remains callable
    // and will surface any unverified timer-clear observation independently.
    try {
      cancel();
    } catch {
      /* TimerBag retains cleanup uncertainty. */
    }
    throw error;
  }
}

function createCelebrationCustody(owner?: EffectOwner) {
  let cancelled = false,
    stylesFinished = false,
    pending = 0,
    entered = 0;
  let reset: (() => void) | undefined,
    resetEntered = false;
  let release: (() => void) | undefined;
  let first: { value: unknown } | undefined;
  const before = owner?.beforeEffect;
  const requireCurrent = () => {
    if (cancelled) throw new Error('Celebration owner retired.');
    if (before) Reflect.apply(before, owner, []);
    if (cancelled) throw new Error('Celebration owner retired.');
  };
  const cancel = () => {
    cancelled = true;
    try {
      bag.clear();
    } catch (value) {
      first ??= { value };
    }
    if (reset && !resetEntered && entered === 0) {
      resetEntered = true;
      try {
        reset();
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
  };
  const settled = () => {
    if (!owner || cancelled || !stylesFinished || pending || !bag.idle()) return;
    try {
      requireCurrent();
      cancel();
      release?.();
      release = undefined;
    } catch {
      /* Exact cancellation duty remains retained if completion is refused. */
    }
  };
  const bag = new TimerBag(requireCurrent, settled);
  // Publish exact cancellation before motion observation, lazy import or library entry.
  if (owner) {
    const register = owner.registerCleanup;
    requireCurrent();
    if (register) release = Reflect.apply(register, owner, [cancel]) ?? undefined;
    requireCurrent();
  }
  return {
    bag,
    cancel,
    requireCurrent,
    failed(value: unknown) {
      first ??= { value };
    },
    perform<Result>(producer: () => Result): Result {
      entered++;
      let result!: Result;
      let primary: { value: unknown } | undefined;
      try {
        result = producer();
      } catch (value) {
        primary = { value };
      } finally {
        entered--;
        if (cancelled) {
          try {
            cancel();
          } catch (value) {
            primary ??= { value };
          }
        }
      }
      if (primary) throw primary.value;
      return result;
    },
    setReset(original: () => void) {
      reset = original;
      if (cancelled) cancel();
    },
    finished() {
      stylesFinished = true;
      settled();
    },
    animation(original: ReturnType<Confetti>) {
      if (!owner) return;
      pending++;
      void Promise.resolve(original).then(
        () => {
          pending--;
          settled();
        },
        (value) => {
          pending--;
          first ??= { value };
          try {
            cancel();
          } catch {
            /* Original duty retains failure. */
          }
        }
      );
    },
  };
}

function createOwnedFire(
  confetti: Confetti,
  producer: (options: Options) => ReturnType<Confetti>,
  requireCurrent: () => void,
  animation: (original: ReturnType<Confetti>) => void,
  perform: <Result>(producer: () => Result) => Result
): Fire {
  const invoke = <Args extends unknown[], Result>(
    receiver: unknown,
    method: (...args: Args) => Result,
    args: Args
  ): Result => {
    requireCurrent();
    return Reflect.apply(method, receiver, args);
  };
  const fire: Fire = Object.assign(
    (args: Options) => {
      // Spread preparation happens here before the final check, including
      // caller-supplied palette entries passed to the owned library entry.
      const prepared = { ...args, colors: args.colors?.slice() };
      const method = producer;
      return perform(() => {
        const original = invoke(undefined, method, [prepared]);
        animation(original);
        requireCurrent();
        return original;
      });
    },
    {
      shapeFromText: (...args: Parameters<Confetti['shapeFromText']>) => {
        const method = confetti.shapeFromText;
        return invoke(confetti, method, args);
      },
    }
  );
  return fire;
}

function runCelebrationStyle(input: {
  kind: CelebrationKind;
  fire: Fire;
  origin: CelebrationOrigin;
  colors: string[];
  count: number;
  emoji: string;
  bag: TimerBag;
}): void {
  const { kind, fire, origin, colors, count, emoji, bag } = input;
  switch (kind) {
    case 'burst':
      fireBurst(fire, origin, { colors, particleCount: count, bag });
      break;
    case 'stars':
      fireStars(fire, origin, colors, bag);
      break;
    case 'fireworks':
      fireFireworks(fire, colors, bag);
      break;
    case 'cannons':
      fireCannons(fire, colors, bag);
      break;
    case 'emoji':
      fireEmoji(fire, origin, emoji, bag);
      break;
    case 'rain':
      fireRain(fire, colors, bag);
      break;
  }
}
