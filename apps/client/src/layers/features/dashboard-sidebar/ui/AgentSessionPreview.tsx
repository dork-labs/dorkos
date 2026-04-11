import { useMemo } from 'react';
import { motion, type TargetAndTransition, type Transition } from 'motion/react';
import { Hand } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { useSessionBorderState } from '@/layers/entities/session';
import { useNow } from '@/layers/shared/model';

interface AgentSessionPreviewProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
}

/**
 * Compact session row for the expanded agent view in the dashboard sidebar.
 * Shows title, relative time, and status border consistent with SessionItem.
 */
export function AgentSessionPreview({ session, isActive, onClick }: AgentSessionPreviewProps) {
  const borderState = useSessionBorderState(session.id, isActive);

  const now = useNow(60_000);
  const relativeTime = useMemo(
    () => formatRelativeTime(session.updatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.updatedAt, now]
  );

  const { animate, transition } = usePulseMotion(
    borderState.pulse,
    borderState.color,
    borderState.dimColor
  );

  return (
    <motion.button
      type="button"
      onClick={onClick}
      animate={animate}
      transition={transition}
      style={borderState.pulse ? undefined : { borderLeftColor: borderState.color }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors duration-100',
        isActive
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <span className="flex shrink-0 items-center gap-1">
        {borderState.kind === 'pendingApproval' && (
          <Hand className="size-(--size-icon-xs) text-amber-500" aria-label="Awaiting approval" />
        )}
        <span className="text-muted-foreground/60 text-[10px]">{relativeTime}</span>
      </span>
    </motion.button>
  );
}

/** Build stable motion props for the border pulse animation. */
function usePulseMotion(
  pulse: boolean,
  color: string,
  dimColor: string | undefined
): { animate: TargetAndTransition | undefined; transition: Transition | undefined } {
  return useMemo(() => {
    if (!pulse || !dimColor) return { animate: undefined, transition: undefined };
    return {
      animate: { borderLeftColor: [color, dimColor, color] },
      transition: {
        borderLeftColor: { duration: 2, repeat: Infinity, ease: 'easeInOut' as const },
      },
    };
  }, [pulse, color, dimColor]);
}
