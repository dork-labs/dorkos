'use client';

import { AnimatePresence, motion } from 'motion/react';
import { DockSlot } from './DockSlot';
import { INTEGRATIONS } from './integrations';

interface AppDockProps {
  /** Whether the dock is mounted (the apps have arrived). */
  present: boolean;
  /** Whether the dock is visible — it fades out once the laptop forms. */
  visible: boolean;
  /** Ids of apps already used by the chat; their slots read as empty. */
  used: ReadonlySet<string>;
}

/** The row of connectable apps beneath the chat. */
export function AppDock({ present, visible, used }: AppDockProps) {
  return (
    <motion.ul
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-14 list-none items-center justify-center gap-3"
    >
      <AnimatePresence>
        {present &&
          INTEGRATIONS.map((integration, i) => (
            <DockSlot
              key={integration.id}
              integration={integration}
              index={i}
              used={used.has(integration.id)}
            />
          ))}
      </AnimatePresence>
    </motion.ul>
  );
}
