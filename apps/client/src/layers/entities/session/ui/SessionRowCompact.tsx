import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Hand } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { PRESS_ROW, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { RuntimeMark } from '@/layers/entities/runtime';
import { useSessionBorderState } from '../model/use-session-border-state';
import { useInlineRename } from '../model/use-inline-rename';
import { usePulseMotion } from '../model/use-pulse-motion';
import { sessionDisplayTitle } from '../lib/session-display-title';
import { useNow } from '@/layers/shared/model';
import { SessionContextMenu } from './SessionContextMenu';
import { SessionOriginMark } from './SessionOriginMark';
import { AccountMark } from './AccountMark';

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
  const {
    isRenaming,
    renameValue,
    setRenameValue,
    inputRef: renameInputRef,
    start: startRename,
    commit: commitRename,
    handleKeyDown: handleRenameKeyDown,
  } = useInlineRename({
    value: session.title,
    onCommit: (next) => onRename?.(session.id, next),
  });

  const borderState = useSessionBorderState(session.id);

  const now = useNow(60_000);
  const relativeTime = useMemo(
    () => formatRelativeTime(session.updatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.updatedAt, now]
  );

  // `pulsing`, not `borderState.pulse`, decides whether the static colour is
  // painted below: the hook owns the reduced-motion gate now, so asking the
  // state instead of the hook would leave an uncoloured dot for anyone whose
  // pulse was gated away.
  const { animate, transition, pulsing } = usePulseMotion(
    borderState.pulse,
    borderState.color,
    borderState.dimColor,
    'backgroundColor'
  );

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
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs',
              PRESS_ROW,
              isActive
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {/* Dot indicator */}
            <motion.span
              aria-hidden
              // Reports what the hook decided. No motion prop is assertable in
              // jsdom, so this attribute is the only observable half.
              data-pulsing={pulsing ? 'true' : 'false'}
              animate={animate}
              transition={transition}
              style={pulsing ? undefined : { backgroundColor: borderState.color }}
              className="size-1.5 shrink-0 rounded-full"
            />
            {isRenaming ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="bg-background text-foreground min-w-0 flex-1 rounded border px-1 text-xs outline-none"
                aria-label="Session title"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{sessionDisplayTitle(session.title)}</span>
            )}
            <span className="flex shrink-0 items-center gap-1">
              {borderState.kind === 'pendingApproval' && (
                <Hand
                  className="size-(--size-icon-xs) text-amber-500"
                  aria-label="Awaiting approval"
                />
              )}
              <SessionOriginMark
                origin={session.origin}
                label={session.originLabel}
                className="text-muted-foreground/50"
              />
              <RuntimeMark
                type={session.runtime}
                model={session.model}
                className="text-muted-foreground/50"
              />
              <AccountMark account={session.account} className="text-muted-foreground/60" />
              <span className="text-muted-foreground/60 text-3xs">{relativeTime}</span>
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
