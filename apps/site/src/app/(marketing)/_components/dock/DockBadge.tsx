'use client';

import { motion } from 'motion/react';
import { dockLayoutId, findDockApp, type DockAppId } from './dock-apps';
import { POP } from '../motion-tokens';

interface DockBadgeProps {
  id: DockAppId;
  /**
   * Whether this badge is the one the dock tile flies into.
   *
   * Only one badge per id may hold the shared layout id, and the storyboard
   * shows the same conversation in several frames at once. Two elements
   * claiming one layout id makes the flight land in whichever motion saw last.
   */
  flight?: boolean;
}

/** In-message icon; shares a layout id with its dock slot so it flies in. */
export function DockBadge({ id, flight = true }: DockBadgeProps) {
  const app = findDockApp(id);
  if (!app) return null;
  return (
    <motion.span
      layoutId={flight ? dockLayoutId(app.id) : undefined}
      transition={POP}
      className="mr-1.5 inline-grid size-5 shrink-0 place-items-center rounded-md align-text-bottom"
      style={{ backgroundColor: `${app.color}22`, color: app.color }}
    >
      <app.Icon size={12} />
    </motion.span>
  );
}
