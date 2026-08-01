/**
 * A number that climbs to its new value instead of jumping to it.
 *
 * @module features/chat/ui/chips/TickingNumber
 */
import { useEffect } from 'react';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { DIFFSTAT_TICK } from './chip-motion';

export interface TickingNumberProps {
  /** The number to show. */
  value: number;
  /**
   * Whether the value is still being written. A settled number is plain text —
   * only a count that is still climbing has anything to animate.
   */
  live: boolean;
}

/**
 * Show a number, and spring to it when it changes.
 *
 * This is the edit chip's diffstat ticking up as hunks land. It is a real
 * interpolation of the value the transcript reports, not the mockup's fake
 * odometer: a spring drives the displayed number from the old count to the new
 * one, so `+4` becoming `+12` is a climb rather than a jump, and the number is
 * never one the accumulator did not produce.
 *
 * Two states render as plain text rather than a spring. A **settled** number has
 * nothing left to climb to — a chip whose tool has finished is a fact, and a
 * fact does not move. And a reader who has **asked for less motion** gets the
 * number, immediately. In both cases the text is React's, which is also what
 * keeps the value honest: the spring writes to the DOM directly, so anything
 * reading a settled chip reads the number itself.
 *
 * @param props - The value, and whether it is still being written.
 */
export function TickingNumber({ value, live }: TickingNumberProps) {
  const reducedMotion = useReducedMotion() ?? false;
  // Initialised to the current value, so a chip that mounts mid-turn shows the
  // count it already has instead of climbing to it from zero.
  const spring = useSpring(value, DIFFSTAT_TICK);
  const rounded = useTransform(spring, (latest) => Math.round(latest));

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  if (!live || reducedMotion) return <>{value}</>;

  return <motion.span>{rounded}</motion.span>;
}
