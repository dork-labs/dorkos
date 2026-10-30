import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

/**
 * The sidebar's dynamic body, sliding sideways when it is swapped.
 *
 * This wrapper is the clip boundary for the swap. The slide transform lives on the
 * motion.div, so the motion.div's own `overflow-hidden` can only clip its children,
 * never its own translated box. The clip must therefore sit on this ancestor: every
 * body swap (dashboard, session, and contributed takeovers, current and future)
 * slides within the sidebar shell seam, so mid-flight content can't spill past the
 * sidebar's edge. The footer and rail are siblings of this wrapper, so they stay
 * outside the clip.
 *
 * @param props.slotKey - What identifies the body, so a new one animates in.
 * @param props.direction - Which way it slides: 1 or -1.
 * @param props.children - The body. Contributed takeovers arrive pre-wrapped in
 *   SidebarBodyErrorBoundary + Suspense at the slot seam (useSidebarSlot); the
 *   built-in dashboard and session bodies are eager and never suspend.
 */
export function SidebarBodySwap({
  slotKey,
  direction,
  children,
}: {
  slotKey: string;
  direction: number;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={slotKey}
          data-testid="sidebar-body-swap"
          custom={direction}
          initial="enter"
          animate="center"
          exit="exit"
          variants={{
            enter: (dir: number) => ({ x: `${dir * 100}%`, opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (dir: number) => ({ x: `${dir * -100}%`, opacity: 0 }),
          }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
