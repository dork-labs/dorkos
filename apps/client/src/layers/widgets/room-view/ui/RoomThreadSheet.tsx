/**
 * A thread on a phone: a full-screen sheet over its room.
 *
 * @module widgets/room-view/ui/RoomThreadSheet
 */
import type { ReactNode } from 'react';
import { motion, useReducedMotion, type PanInfo } from 'motion/react';

/**
 * How far right a swipe has to carry the sheet before letting go closes it, in
 * pixels — or how fast it has to be moving, in pixels per second. Either is a
 * deliberate swipe; a slow drag that stops short springs back.
 */
export const SHEET_SWIPE_CLOSE_DISTANCE = 96;

/** See {@link SHEET_SWIPE_CLOSE_DISTANCE}. */
export const SHEET_SWIPE_CLOSE_VELOCITY = 500;

/**
 * Whether a released swipe closes the sheet.
 *
 * @param info - Where the drag ended up, and how fast it was going.
 */
export function swipeCloses(info: Pick<PanInfo, 'offset' | 'velocity'>): boolean {
  return info.offset.x > SHEET_SWIPE_CLOSE_DISTANCE || info.velocity.x > SHEET_SWIPE_CLOSE_VELOCITY;
}

/** Props for {@link RoomThreadSheet}. */
export interface RoomThreadSheetProps {
  /** The thread panel, drawn as the whole sheet. */
  children: ReactNode;
  /** Close the thread — Back, or a swipe to the right. */
  onClose: () => void;
}

/**
 * The phone's thread sheet: it slides in from the right over the room, and the
 * room stays where it was underneath.
 *
 * **Over the room, never instead of it.** The room column stays mounted (and
 * `inert`) under the sheet, so coming back from a thread lands exactly where
 * the reader was — the push this replaces unmounted the room, and a room
 * mounted fresh starts again at its newest message.
 *
 * **Three ways out**: the Back button in the panel's header, Escape, and a
 * swipe to the right — the gesture a phone already uses to go back. The swipe
 * is locked to its first direction, so scrolling the thread up and down never
 * drags the sheet sideways.
 *
 * **Reduced motion cuts** rather than slides: the sheet is simply there, and
 * simply gone.
 *
 * The caller wraps it in an `AnimatePresence`, which is what lets the sheet
 * slide back out rather than vanish.
 *
 * @param props - The panel, and how to close it.
 */
export function RoomThreadSheet({ children, onClose }: RoomThreadSheetProps) {
  const reducedMotion = useReducedMotion() === true;
  const travel = reducedMotion ? { x: 0 } : { x: '100%' };
  return (
    <motion.div
      data-testid="room-thread-sheet"
      className="bg-card absolute inset-0 z-10 flex flex-col shadow-xl"
      initial={travel}
      animate={{ x: 0 }}
      exit={travel}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      drag="x"
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      // Rightward only: a swipe to the left has nowhere to go.
      dragElastic={{ left: 0, right: 0.9 }}
      dragMomentum={false}
      onDragEnd={(_event, info) => {
        if (swipeCloses(info)) onClose();
      }}
    >
      {children}
    </motion.div>
  );
}
