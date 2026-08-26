import { ramp } from '../motion-tokens';

/**
 * Where each visual change happens along the pinned stage, as a fraction of
 * its scroll. Tuning the animation means editing these numbers — the live
 * page and `/test/storyboard` both read them, so they cannot drift apart.
 */
export const STAGE_TIMING = {
  /** The chat starts shrinking toward the laptop. */
  shrinkFrom: 0.68,
  /** The chat has reached its final size. */
  shrinkTo: 0.92,
  /** How much of its size the chat gives up (1 → 0.54). */
  shrinkAmount: 0.46,
  /** The closing caption begins to appear. */
  captionFrom: 0.9,
  /** The closing caption is fully legible. */
  captionTo: 0.98,

  // The machine reads the same scroll. It shares the shrink window above — the
  // chat reaches its seat exactly when it reaches its final size — and adds
  // these of its own.

  /** The machine starts rising into the stage from below. */
  machineFrom: 0.76,
  /**
   * The machine is solid. Much earlier than it finishes moving, and that is
   * the point: a dark enclosure held at half opacity over a cream page is a
   * grey smear, so it stops being transparent almost as soon as it appears and
   * does the rest of its arriving as a solid object sliding up from under the
   * frame.
   */
  machineFadeTo: 0.82,
  /** The machine has arrived at its seat. */
  machineTo: 0.9,
  /** How far below its seat the machine starts, as a percentage of its height. */
  machineRise: 85,
  /** How far above its seat the chat waits, as a percentage of the screen's height. */
  chatDrop: 12,
  /** Degrees the chat lays back onto the lid plane at the midpoint of its flight. */
  layBack: 9,
} as const;

/** Scale of the chat card at a given point in the stage. */
export function chatScaleAt(progress: number): number {
  return (
    1 - ramp(progress, STAGE_TIMING.shrinkFrom, STAGE_TIMING.shrinkTo) * STAGE_TIMING.shrinkAmount
  );
}

/**
 * How far the chat has travelled toward its seat, 0 to 1.
 *
 * Deliberately the same window as the shrink: the card finishes falling into
 * the screen at the moment it finishes getting smaller, so there is one
 * arrival rather than two.
 */
export function seatAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.shrinkFrom, STAGE_TIMING.shrinkTo);
}

/** How far the machine has risen into the stage, 0 before it starts. */
export function machineArrivalAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.machineFrom, STAGE_TIMING.machineTo);
}

/** How solid the machine is — separate from where it is, and quicker. */
export function machineOpacityAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.machineFrom, STAGE_TIMING.machineFadeTo);
}

/**
 * Degrees the chat is laid back at a given point — nothing, then a lean, then
 * nothing again.
 *
 * The card starts square to the reader and ends square to the reader, because
 * it is a conversation and it has to stay legible at both ends. In between it
 * tips away onto the plane of the lid it is falling into, which is the whole
 * of the illusion and costs one rotation.
 */
export function layBackAt(progress: number): number {
  return -Math.sin(Math.PI * seatAt(progress)) * STAGE_TIMING.layBack;
}

/** Opacity of the "home sweet localhost" caption at a given point. */
export function captionOpacityAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.captionFrom, STAGE_TIMING.captionTo);
}
