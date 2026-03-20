import { motion, AnimatePresence } from 'motion/react';

interface ScanLineProps {
  /** Agent accent color (CSS color string). */
  color: string;
  /** Tokens actively flowing — accelerates beam, enables highlight layer. */
  isTextStreaming: boolean;
  /** Fade all layers to transparent at the left and right edges. @default true */
  fadeEdges?: boolean;
  /** Which edge of the parent to anchor to. @default 'bottom' */
  edge?: 'top' | 'bottom';
}

/**
 * Three-layer composited light scanner that sweeps across a parent edge while
 * an agent is streaming. Layers: ambient glow, gradient comet beam, and an
 * energy highlight that only appears during token generation.
 *
 * Root is a motion.div so the outer AnimatePresence can animate exit (fade out
 * the entire composite in one pass rather than requiring per-layer exit logic).
 */
export function ScanLine({
  color,
  isTextStreaming,
  fadeEdges = true,
  edge = 'bottom',
}: ScanLineProps) {
  const beamDuration = isTextStreaming ? 1.8 : 2.5;
  const edgeMask = fadeEdges
    ? 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)'
    : undefined;
  const anchorClass =
    edge === 'top'
      ? 'pointer-events-none absolute right-0 top-0 left-0'
      : 'pointer-events-none absolute right-0 bottom-0 left-0';
  const layerAnchor = edge === 'top' ? 'top' : 'bottom';

  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className={anchorClass}
      style={{
        /* 10px contains all layers including the 3px glow blur; 0px when
           unmasked so the blur can extend freely via overflow: visible. */
        height: fadeEdges ? 10 : 0,
        overflow: fadeEdges ? 'hidden' : 'visible',
        maskImage: edgeMask,
        WebkitMaskImage: edgeMask,
      }}
    >
      {/* Layer 1: Ambient glow — static, always visible while mounted */}
      <div
        className="absolute right-0 left-0"
        style={{
          [layerAnchor]: 0,
          height: 6,
          backgroundColor: color,
          opacity: 0.6,
          filter: 'blur(3px)',
        }}
      />

      {/* Layer 2: Scanner beam — gradient comet sweeping left to right */}
      <motion.div
        initial={{ x: '-100%' }}
        animate={{ x: '433%' }}
        transition={{
          x: { duration: beamDuration, repeat: Infinity, ease: 'linear' },
        }}
        className="absolute"
        style={{
          [layerAnchor]: 0,
          width: '30%',
          height: 2,
          background: `linear-gradient(to right, transparent, ${color}, white, transparent)`,
          willChange: 'transform',
        }}
      />

      {/* Layer 3: Energy highlight — fast, bright, only during token generation */}
      <AnimatePresence>
        {isTextStreaming && (
          <motion.div
            initial={{ opacity: 0, x: '-100%' }}
            animate={{ opacity: 0.9, x: '1525%' }}
            exit={{ opacity: 0 }}
            transition={{
              x: { duration: 1.1, repeat: Infinity, ease: 'linear' },
              opacity: { duration: 0.2 },
            }}
            className="absolute"
            style={{
              [layerAnchor]: 0,
              width: '8%',
              height: 1,
              background:
                'linear-gradient(to right, transparent, white 40%, white 60%, transparent)',
              willChange: 'transform',
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
