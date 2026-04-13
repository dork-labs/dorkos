import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const borderState = useSessionBorderState(session.id);

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

  useEffect(() => {
    if (isRenaming) {
      committedRef.current = false;
      // Delay focus so it wins over Radix's focus-restoration when the context menu closes.
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [isRenaming]);

  const startRename = useCallback(() => {
    setRenameValue(session.title);
    setIsRenaming(true);
  }, [session.title]);

  const commitRename = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = renameValue.trim();
    setIsRenaming(false);
    if (!trimmed || trimmed === session.title) return;
    onRename?.(session.id, trimmed);
  }, [renameValue, session.id, session.title, onRename]);

  const cancelRename = useCallback(() => {
    committedRef.current = true;
    setIsRenaming(false);
  }, []);

  return (
    <Tooltip>
      <SessionContextMenu
        onRename={onRename ? startRename : undefined}
        onFork={onFork ? () => onFork(session.id) : undefined}
      >
        <TooltipTrigger asChild>
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
            {isRenaming ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="bg-background text-foreground min-w-0 flex-1 rounded border px-1 text-xs outline-none"
                aria-label="Session title"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
            )}
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
      </SessionContextMenu>
      {borderState.kind !== 'idle' && (
        <TooltipContent side="right" sideOffset={8}>
          {borderState.label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
