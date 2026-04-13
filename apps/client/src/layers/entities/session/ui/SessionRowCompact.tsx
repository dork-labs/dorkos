import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Hand } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { useSessionBorderState } from '../model/use-session-border-state';
import { usePulseMotion } from '../model/use-pulse-motion';
import { useNow } from '@/layers/shared/model';
import { SessionContextMenu } from './SessionContextMenu';

interface SessionRowCompactProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onFork?: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => void;
}

/** Compact single-line session row with dot status indicator. */
export function SessionRowCompact({
  session,
  isActive,
  onClick,
  onFork,
  onRename,
}: SessionRowCompactProps) {
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
    borderState.dimColor,
    'backgroundColor'
  );

  return (
    <SessionContextMenu
      onRename={onRename ? () => onRename(session.id, session.title) : undefined}
      onFork={onFork ? () => onFork(session.id) : undefined}
    >
      <Tooltip>
        <TooltipTrigger asChild disabled={borderState.kind === 'idle'}>
          <button
            type="button"
            data-testid="session-row"
            onClick={onClick}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-100 active:scale-[0.98]',
              isActive
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {/* Dot indicator */}
            <motion.span
              aria-hidden
              animate={animate}
              transition={transition}
              style={borderState.pulse ? undefined : { backgroundColor: borderState.color }}
              className="size-1.5 shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="flex shrink-0 items-center gap-1">
              {borderState.kind === 'pendingApproval' && (
                <Hand
                  className="size-(--size-icon-xs) text-amber-500"
                  aria-label="Awaiting approval"
                />
              )}
              <span className="text-muted-foreground/60 text-[10px]">{relativeTime}</span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {borderState.label}
        </TooltipContent>
      </Tooltip>
    </SessionContextMenu>
  );
}
