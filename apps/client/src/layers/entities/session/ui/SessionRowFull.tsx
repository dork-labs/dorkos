import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, type TargetAndTransition, type Transition } from 'motion/react';
import { ChevronDown, Pencil, ShieldOff, GitFork, Hand } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { CopyButton, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { RuntimeMark, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useSessionBorderState, type SessionBorderState } from '../model/use-session-border-state';
import { usePulseMotion } from '../model/use-pulse-motion';
import { sessionDisplayTitle } from '../lib/session-display-title';
import { useNow } from '@/layers/shared/model';
import { SessionContextMenu } from './SessionContextMenu';

interface SessionRowFullProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onFork?: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => void;
  isNew?: boolean;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Full session row with expandable details, rename, and status border. */
export function SessionRowFull({
  session,
  isActive,
  onClick,
  onFork,
  onRename,
  isNew = false,
}: SessionRowFullProps) {
  const [expanded, setExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const isUnsafe: boolean = session.permissionMode === 'bypassPermissions';

  const now = useNow(60_000);
  const relativeTime = useMemo(
    () => formatRelativeTime(session.updatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.updatedAt, now]
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

  const borderState = useSessionBorderState(session.id);

  const handleExpandToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }, []);

  const handleStartRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      startRename();
    },
    [startRename]
  );

  const { animate, transition, initial } = useEntryAndPulse({ isNew, borderState });

  return (
    <Tooltip>
      <motion.div
        data-testid="session-row"
        initial={initial}
        animate={animate}
        transition={transition}
        style={borderState.pulse ? undefined : { borderLeftColor: borderState.color }}
        className={cn(
          'group relative rounded-lg border-l-2 transition-colors duration-150',
          isActive && 'text-foreground'
        )}
      >
        {isActive && (
          <motion.div
            layoutId="active-session-bg"
            className="bg-secondary absolute inset-0 rounded-lg"
            transition={{ type: 'spring', stiffness: 280, damping: 32 }}
          />
        )}
        <SessionContextMenu
          onRename={onRename ? startRename : undefined}
          onFork={onFork ? () => onFork(session.id) : undefined}
        >
          <TooltipTrigger asChild disabled={borderState.kind === 'idle'}>
            <motion.div
              role="button"
              tabIndex={0}
              aria-current={isActive ? 'page' : undefined}
              aria-label={`Session: ${sessionDisplayTitle(session.title)}. ${borderState.label}.`}
              onClick={onClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick();
                }
              }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="relative z-10 cursor-pointer px-3 py-2"
            >
              {/* Line 1: relative time + icons + expand chevron */}
              <div className="text-muted-foreground flex items-center gap-1 text-xs">
                <span className="min-w-0 flex-1">{relativeTime}</span>
                <span className="flex flex-shrink-0 items-center gap-1">
                  {borderState.kind === 'pendingApproval' && (
                    <Hand
                      className="size-(--size-icon-xs) text-amber-500"
                      aria-label="Awaiting your approval"
                    />
                  )}
                  {isUnsafe && <BypassPermissionsIcon />}
                  {onRename && !isRenaming && (
                    <button
                      type="button"
                      onClick={handleStartRename}
                      className="text-muted-foreground/60 hover:text-muted-foreground rounded p-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 max-md:p-1.5 max-md:opacity-100"
                      aria-label="Rename session"
                    >
                      <Pencil className="size-(--size-icon-xs)" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleExpandToggle}
                    className={cn(
                      'rounded p-0.5 transition-opacity duration-150 max-md:p-1.5',
                      expanded
                        ? 'text-muted-foreground opacity-100'
                        : 'text-muted-foreground/60 hover:text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100'
                    )}
                    aria-label="Session details"
                    aria-expanded={expanded}
                  >
                    <motion.div
                      animate={{ rotate: expanded ? 180 : 0 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    >
                      <ChevronDown className="size-(--size-icon-sm)" />
                    </motion.div>
                  </button>
                </span>
              </div>

              {/* Line 2: title or rename input */}
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
                  className="bg-background text-foreground mt-0.5 w-full rounded border px-1 text-xs outline-none"
                  aria-label="Session title"
                />
              ) : (
                <div className="mt-0.5 flex items-center gap-1.5">
                  <RuntimeMark
                    type={session.runtime}
                    model={session.model}
                    className="text-muted-foreground/50"
                  />
                  <div
                    className="text-muted-foreground/70 min-w-0 flex-1 truncate text-xs"
                    title={onRename ? 'Click the pencil icon to rename' : undefined}
                  >
                    {sessionDisplayTitle(session.title)}
                  </div>
                </div>
              )}
            </motion.div>
          </TooltipTrigger>
        </SessionContextMenu>
        <TooltipContent side="right" sideOffset={8}>
          {borderState.label}
        </TooltipContent>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="relative z-10 overflow-hidden"
            >
              <div className="text-muted-foreground border-border/30 mx-2 space-y-1.5 border-t px-3 pt-2 pb-2 text-[11px]">
                <DetailRow label="Session ID" value={session.id} copyable />
                <DetailRow label="Created" value={formatTimestamp(session.createdAt)} />
                <DetailRow label="Updated" value={formatTimestamp(session.updatedAt)} />
                <DetailRow label="Runtime" value={getRuntimeDescriptor(session.runtime).label} />
                <DetailRow label="Permissions" value={isUnsafe ? 'Skip (unsafe)' : 'Default'} />
                {onFork && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFork(session.id);
                    }}
                    className="hover:bg-secondary/80 text-muted-foreground/60 hover:text-muted-foreground mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-100"
                    aria-label="Fork session"
                  >
                    <GitFork className="size-(--size-icon-xs)" />
                    <span>Fork</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </Tooltip>
  );
}

function BypassPermissionsIcon() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-help"
          aria-label="Permissions bypassed"
          onClick={(e) => e.stopPropagation()}
        >
          <ShieldOff className="size-(--size-icon-xs) text-red-500" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Permissions bypassed — agent can run any command without approval
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Build memoized motion props for entry animation + border pulse.
 * Uses `usePulseMotion` for the pulse portion and layers `isNew` fade+slide on top.
 */
function useEntryAndPulse({
  isNew,
  borderState,
}: {
  isNew: boolean;
  borderState: SessionBorderState;
}): {
  initial: { opacity: number; y: number } | undefined;
  animate: TargetAndTransition | undefined;
  transition: Transition | undefined;
} {
  const { animate: pulseAnimate, transition: pulseTransition } = usePulseMotion(
    borderState.pulse,
    borderState.color,
    borderState.dimColor
  );

  return useMemo(() => {
    const needsMotion = isNew || borderState.pulse;
    if (!needsMotion) {
      return { initial: undefined, animate: undefined, transition: undefined };
    }
    const animate: TargetAndTransition = {
      ...(isNew ? { opacity: 1, y: 0 } : {}),
      ...pulseAnimate,
    };
    const transition: Transition = {
      ...(isNew
        ? {
            opacity: { duration: 0.2, ease: [0, 0, 0.2, 1] as const },
            y: { duration: 0.2, ease: [0, 0, 0.2, 1] as const },
          }
        : {}),
      ...pulseTransition,
    };
    return {
      initial: isNew ? { opacity: 0, y: -8 } : undefined,
      animate,
      transition,
    };
  }, [isNew, borderState.pulse, pulseAnimate, pulseTransition]);
}

function DetailRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground/60 w-16 flex-shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono select-all">{value}</span>
      {copyable && <CopyButton value={value} label={`Copy ${label}`} />}
    </div>
  );
}
