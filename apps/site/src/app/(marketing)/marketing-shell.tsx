'use client';

import { MotionConfig } from 'motion/react';

/** Client wrapper that enables reduced-motion respect for all marketing animations. */
export function MarketingShell({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
