import React, { useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib/utils';

type Direction = 'TOP' | 'LEFT' | 'BOTTOM' | 'RIGHT';

const DIRECTIONS: Direction[] = ['TOP', 'LEFT', 'BOTTOM', 'RIGHT'];

const MOVING_MAP: Record<Direction, string> = {
  TOP: 'radial-gradient(20.7% 50% at 50% 0%, hsl(var(--brand) / 0.7) 0%, transparent 100%)',
  LEFT: 'radial-gradient(16.6% 43.1% at 0% 50%, hsl(var(--brand) / 0.7) 0%, transparent 100%)',
  BOTTOM: 'radial-gradient(20.7% 50% at 50% 100%, hsl(var(--brand) / 0.7) 0%, transparent 100%)',
  RIGHT: 'radial-gradient(16.2% 41.2% at 100% 50%, hsl(var(--brand) / 0.7) 0%, transparent 100%)',
};

const HIGHLIGHT = 'radial-gradient(75% 181.2% at 50% 50%, hsl(var(--brand)) 0%, transparent 100%)';

/**
 * Button with an animated gradient border that highlights on hover.
 *
 * @see https://ui.aceternity.com/components/hover-border-gradient
 */
export function HoverBorderGradient({
  children,
  containerClassName,
  className,
  as: Tag = 'button',
  duration = 1,
  clockwise = true,
  ...props
}: React.PropsWithChildren<
  {
    as?: React.ElementType;
    containerClassName?: string;
    className?: string;
    duration?: number;
    clockwise?: boolean;
  } & React.HTMLAttributes<HTMLElement>
>) {
  const reducedMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [direction, setDirection] = useState<Direction>('TOP');

  useEffect(() => {
    if (reducedMotion || hovered) return;
    const interval = setInterval(() => {
      setDirection((prev) => {
        const idx = DIRECTIONS.indexOf(prev);
        const next = clockwise
          ? (idx - 1 + DIRECTIONS.length) % DIRECTIONS.length
          : (idx + 1) % DIRECTIONS.length;
        return DIRECTIONS[next];
      });
    }, duration * 1000);
    return () => clearInterval(interval);
  }, [hovered, reducedMotion, duration, clockwise]);

  return (
    <Tag
      data-slot="hover-border-gradient"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'bg-muted/40 hover:bg-muted/20 relative flex h-min w-fit items-center justify-center overflow-visible rounded-md border border-transparent p-px transition duration-500',
        containerClassName
      )}
      {...props}
    >
      <div
        className={cn(
          'bg-brand text-brand-foreground z-10 w-auto rounded-[inherit] px-4 py-2 text-sm font-medium',
          className
        )}
      >
        {children}
      </div>
      <motion.div
        className="absolute inset-0 z-0 flex-none overflow-hidden rounded-[inherit]"
        style={{ filter: 'blur(2px)' }}
        initial={{ background: MOVING_MAP[direction] }}
        animate={{
          background: hovered ? [MOVING_MAP[direction], HIGHLIGHT] : MOVING_MAP[direction],
        }}
        transition={{ ease: 'linear', duration: reducedMotion ? 0 : (duration ?? 1) }}
      />
      <div className="bg-brand absolute inset-[2px] z-[1] flex-none rounded-[inherit]" />
    </Tag>
  );
}
