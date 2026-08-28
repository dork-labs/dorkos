'use client';

import { AnimatePresence, motion } from 'motion/react';
import { DOCK } from './dock-apps';
import { DockSlot } from './DockSlot';

interface DockProps {
  /** Whether the dock is mounted (the tiles have arrived). */
  present: boolean;
  /** Whether the dock is visible — it fades out once the laptop forms. */
  visible: boolean;
  /** Ids already used by the chat; their slots read as empty. */
  used: ReadonlySet<string>;
}

/** The row of things you can add, beneath the chat. */
export function Dock({ present, visible, used }: DockProps) {
  return (
    <motion.ul
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-14 list-none items-center justify-center gap-3"
    >
      <AnimatePresence>
        {present &&
          DOCK.map((app, i) => (
            <DockSlot key={app.id} app={app} index={i} used={used.has(app.id)} />
          ))}
      </AnimatePresence>
    </motion.ul>
  );
}
