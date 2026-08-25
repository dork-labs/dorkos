'use client';

import { motion } from 'motion/react';
import { dockLayoutId, type DockApp } from './dock-apps';
import { POP } from './motion-tokens';

interface DockSlotProps {
  app: DockApp;
  /** Position on the dock, used to stagger the pop-in. */
  index: number;
  /** Once the tile has been used, its icon has flown into the chat. */
  used: boolean;
}

/**
 * One tile on the dock. The icon shares a layout id with its in-message badge,
 * so when the chat uses it the icon flies out and leaves this slot empty.
 */
export function DockSlot({ app, index, used }: DockSlotProps) {
  return (
    <motion.li
      initial={{ opacity: 0, scale: 0.4, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ ...POP, delay: index * 0.07 }}
      title={app.label}
      className="border-border-warm relative grid size-12 place-items-center rounded-xl border border-dashed"
    >
      {!used && (
        <motion.span
          layoutId={dockLayoutId(app.id)}
          transition={POP}
          className="border-border-warm bg-cream-white absolute inset-0 grid place-items-center rounded-xl border"
          style={{ color: app.color }}
        >
          <app.Icon size={20} />
        </motion.span>
      )}
    </motion.li>
  );
}
