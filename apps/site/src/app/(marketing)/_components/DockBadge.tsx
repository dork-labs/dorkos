'use client';

import { motion } from 'motion/react';
import { dockLayoutId, findDockApp, type DockAppId } from './dock-apps';
import { POP } from './motion-tokens';

/** In-message icon; shares a layout id with its dock slot so it flies in. */
export function DockBadge({ id }: { id: DockAppId }) {
  const app = findDockApp(id);
  if (!app) return null;
  return (
    <motion.span
      layoutId={dockLayoutId(app.id)}
      transition={POP}
      className="mr-1.5 inline-grid size-5 shrink-0 place-items-center rounded-md align-text-bottom"
      style={{ backgroundColor: `${app.color}22`, color: app.color }}
    >
      <app.Icon size={12} />
    </motion.span>
  );
}
