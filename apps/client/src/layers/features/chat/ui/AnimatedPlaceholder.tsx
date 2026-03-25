import { AnimatePresence, motion } from 'motion/react';

interface AnimatedPlaceholderProps {
  /** Current placeholder text to display. */
  text: string;
  /** Key for AnimatePresence transitions (changes trigger animation). */
  animationKey: number;
}

/** Module-scope variants — avoid inline object recreation per animations guide. */
const variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

const transition = { duration: 0.3, ease: 'easeInOut' } as const;

/**
 * Animated placeholder overlay that crossfades between text strings.
 *
 * Renders as a pointer-events-none overlay positioned over the textarea.
 * The parent must set `position: relative` for correct positioning.
 */
export function AnimatedPlaceholder({ text, animationKey }: AnimatedPlaceholderProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-start overflow-hidden py-0.5">
      <AnimatePresence mode="wait">
        <motion.span
          key={animationKey}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={transition}
          className="text-muted-foreground truncate text-sm"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
