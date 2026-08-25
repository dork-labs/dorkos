'use client';

import { motion } from 'motion/react';
import { PANEL } from './film-tokens';

/** Three pulsing dots shown in a row while an agent is "typing". */
export function TypingDots() {
  return (
    <span className="flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full"
          style={{ backgroundColor: PANEL.dim }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}
