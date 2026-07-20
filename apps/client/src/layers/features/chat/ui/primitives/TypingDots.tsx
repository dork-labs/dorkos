/**
 * Three softly pulsing dots — the calm "something is happening" affordance
 * shared by the chat area's loading and first-light states. Purely decorative,
 * so it is hidden from assistive tech (the surrounding copy carries the meaning).
 *
 * @module features/chat/ui/primitives/TypingDots
 */
import { cn } from '@/layers/shared/lib';

/** Animation start delays (seconds) that stagger the three dots into a wave. */
const DOT_DELAYS = [0, 0.2, 0.4] as const;

/**
 * The staggered three-dot typing affordance.
 *
 * @param props.className - Optional extra classes for the dot row.
 */
export function TypingDots({ className }: { className?: string }) {
  return (
    <div className={cn('flex gap-1', className)} data-testid="typing-dots" aria-hidden="true">
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="bg-muted-foreground h-2 w-2 rounded-full"
          style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}
