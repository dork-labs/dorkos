'use client';

import { motion } from 'motion/react';
import { integrationLayoutId, type Integration } from './integrations';
import { POP } from './motion-tokens';

interface DockSlotProps {
  integration: Integration;
  /** Position on the dock, used to stagger the pop-in. */
  index: number;
  /** Once the app has been used, its icon has flown into the chat. */
  used: boolean;
}

/**
 * One app on the dock. The icon shares a layout id with its in-message badge,
 * so when the chat uses the app the icon flies out and leaves this slot empty.
 */
export function DockSlot({ integration, index, used }: DockSlotProps) {
  return (
    <motion.li
      initial={{ opacity: 0, scale: 0.4, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ ...POP, delay: index * 0.07 }}
      title={integration.label}
      className="relative grid size-12 place-items-center rounded-xl border border-dashed border-(--line)"
    >
      {!used && (
        <motion.span
          layoutId={integrationLayoutId(integration.id)}
          transition={POP}
          className="absolute inset-0 grid place-items-center rounded-xl border border-(--line) bg-(--panel)"
          style={{ color: integration.color }}
        >
          <integration.Icon size={20} />
        </motion.span>
      )}
    </motion.li>
  );
}
