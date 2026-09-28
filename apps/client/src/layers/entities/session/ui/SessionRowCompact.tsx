import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Hand } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import {
  PRESS_ROW,
  STATUS_TONE_SURFACE,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { RuntimeMark } from '@/layers/entities/runtime';
import { useSessionBorderState } from '../model/status/use-session-border-state';
import { useInlineRename } from '../model/rename/use-inline-rename';
import { useSessionRowAccount } from '../model/status/use-session-row-account';
import { LIMIT_ACTION_TEXT_CLASS } from '../lib/session-limit-text';
import { usePulseMotion } from '../model/status/use-pulse-motion';
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

  const account = useSessionRowAccount(session);
  const limitDisplay = account.limitDisplay;
  const borderState = useSessionBorderState(session.id, account.limitStatus);
  // The row's tooltip names the account (the dot has none of its own, so two
  // never open at once) and, when there is one, the row's state.
  const tooltipText = [
    account.visible && account.color ? account.name : null,
    borderState.kind === 'idle' ? null : borderState.label,
  ]
    .filter(Boolean)
    .join(' · ');

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
            // Which out-of-usage look the row wears: `action` is the red tint, `waiting`
            // the neutral one (Q13). Absent when it shows no limit.
            data-limit={
              limitDisplay ? (limitDisplay.needsAction ? 'action' : 'waiting') : undefined
            }
            onClick={onClick}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs',
              PRESS_ROW,
              // The soft red tint of an account that ran out and needs the
              // person (Q13). Before the state classes, so the active
              // highlight and the row's own text colors win over it.
              limitDisplay?.needsAction && STATUS_TONE_SURFACE.error,
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
            {/* The account's dot leads the title; its name is the dot's tooltip (Q4). */}
            <AccountMark account={account} tooltip={false} />
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
              {/* A session that ran out says so where its time sits (§6.2). */}
              {limitDisplay ? (
                <span
                  className={cn(
                    'text-3xs whitespace-nowrap',
                    limitDisplay.needsAction ? LIMIT_ACTION_TEXT_CLASS : 'text-muted-foreground'
                  )}
                >
                  {limitDisplay.text}
                </span>
              ) : (
                // Full muted, never dimmed further: a label on the sidebar and
                // on the red row tint must clear 4.5:1 in both themes (the
                // design system's muted rule, DOR-1098).
                <span className="text-muted-foreground text-3xs">{relativeTime}</span>
              )}
            </span>
          </button>
        </TooltipTrigger>
      </SessionContextMenu>
      {tooltipText && (
        <TooltipContent side="right" sideOffset={8}>
          {tooltipText}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
