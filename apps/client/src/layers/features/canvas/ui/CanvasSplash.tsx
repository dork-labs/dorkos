import { useId, useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { FileText, Braces, Globe, Sparkles } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';

interface CanvasSplashProps {
  /** Called when the user picks a quick-start action. */
  onAction: (content: UiCanvasContent) => void;
}

const QUICK_ACTIONS = [
  {
    icon: FileText,
    label: 'Markdown',
    description: 'Render a document',
    action: (): UiCanvasContent => ({
      type: 'markdown',
      content: '# Untitled\n\nStart writing...',
      title: 'Document',
    }),
  },
  {
    icon: Braces,
    label: 'JSON',
    description: 'Inspect structured data',
    action: (): UiCanvasContent => ({
      type: 'json',
      data: { message: 'Your data here' },
      title: 'JSON Data',
    }),
  },
  {
    icon: Globe,
    label: 'Web Page',
    description: 'Embed a URL',
    action: (): UiCanvasContent => ({
      type: 'url',
      url: 'https://dorkos.ai',
      title: 'Web Page',
    }),
  },
] as const;

/** Deterministic pseudo-random number from a seed string, mapped to [min, max]. */
function seededValue(seed: string, index: number, min: number, max: number): number {
  const hash = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return ((hash * (index + 1) * 7) % (max - min)) + min;
}

/**
 * Animated splash screen for the canvas when opened without content.
 *
 * Shows floating shapes suggesting a blank canvas, a heading, and
 * quick-start action cards for the three content types.
 */
export function CanvasSplash({ onAction }: CanvasSplashProps) {
  const reducedMotion = useReducedMotion();
  const id = useId();

  // Generate deterministic floating shape positions from the component ID
  const shapes = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => ({
      x: seededValue(id, i * 3, 10, 90),
      y: seededValue(id, i * 3 + 1, 10, 80),
      size: seededValue(id, i * 3 + 2, 24, 56),
      delay: i * 0.4,
    }));
  }, [id]);

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6">
      {/* Floating ambient shapes */}
      {!reducedMotion &&
        shapes.map((shape, i) => (
          <motion.div
            key={i}
            className="border-border/40 absolute rounded-lg border"
            style={{
              left: `${shape.x}%`,
              top: `${shape.y}%`,
              width: shape.size,
              height: shape.size,
            }}
            initial={{ opacity: 0, scale: 0.6, rotate: -10 }}
            animate={{
              opacity: [0, 0.15, 0.08, 0.15],
              scale: [0.6, 1, 0.9, 1],
              rotate: [-10, 0, 5, 0],
            }}
            transition={{
              duration: 8,
              delay: shape.delay,
              repeat: Infinity,
              repeatType: 'reverse',
              ease: 'easeInOut',
            }}
          />
        ))}

      {/* Center content */}
      <motion.div
        className="relative z-10 flex max-w-sm flex-col items-center gap-6 text-center"
        initial={reducedMotion ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        {/* Icon */}
        <motion.div
          className="bg-muted/50 text-muted-foreground flex size-14 items-center justify-center rounded-2xl"
          initial={reducedMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <Sparkles className="size-7" />
        </motion.div>

        {/* Heading */}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">A blank canvas</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Your agent can render documents, data, and web pages here.
            <br />
            Or pick a starting point below.
          </p>
        </div>

        {/* Quick-start actions */}
        <motion.div
          className="mt-2 flex w-full flex-col gap-2"
          initial="hidden"
          animate="visible"
          variants={
            reducedMotion
              ? {}
              : { visible: { transition: { staggerChildren: 0.08, delayChildren: 0.25 } } }
          }
        >
          {QUICK_ACTIONS.map(({ icon: Icon, label, description, action }) => (
            <motion.button
              key={label}
              variants={
                reducedMotion ? {} : { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }
              }
              transition={{ duration: 0.25 }}
              className="border-border hover:bg-accent/50 flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
              onClick={() => onAction(action())}
            >
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0">
                <span className="text-sm font-medium">{label}</span>
                <span className="text-muted-foreground ml-2 text-xs">{description}</span>
              </div>
            </motion.button>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
