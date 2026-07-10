import React from 'react';

/**
 * CSS style object for the radial glow effect.
 * Applied via motion.div style props.
 */
export const RADIAL_GLOW_STYLE: React.CSSProperties = {
  background: 'radial-gradient(circle, rgba(255,215,0,0.15) 0%, transparent 70%)',
};

/**
 * Spring animation config for the mini celebration checkmark bounce.
 * Used with motion.div animate={{ scale: [1, 1.4, 1] }}.
 */
export const MINI_SPRING_CONFIG = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 10,
  mass: 0.8,
};

/**
 * Shimmer gradient style for the gold shimmer effect on task rows.
 * Applied as a CSS background-position animation via motion.div.
 */
export const SHIMMER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(90deg, transparent 0%, rgba(255,215,0,0.2) 50%, transparent 100%)',
  backgroundSize: '200% 100%',
};
