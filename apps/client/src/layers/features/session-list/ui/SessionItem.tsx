import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Copy, Check, ShieldOff } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime, TIMING } from '@/layers/shared/lib';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
      } catch {
        // Clipboard API not available
      }
    },
    [text]
  );

  return (
    <button
      onClick={handleCopy}
      className="hover:bg-secondary/80 text-muted-foreground/60 hover:text-muted-foreground rounded p-0.5 transition-colors duration-100 max-md:p-2"
      aria-label={`Copy ${label}`}
    >
      {copied ? (
        <Check className="size-(--size-icon-xs) text-green-500" />
      ) : (
        <Copy className="size-(--size-icon-xs)" />
      )}
    </button>
  );
}

export function SessionItem({ session, isActive, onClick, isNew = false }: SessionItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isSkipMode = session.permissionMode === 'bypassPermissions';

  const Wrapper = isNew ? motion.div : 'div';
  const animationProps = isNew
    ? {
        initial: { opacity: 0, y: -8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
      }
    : {};

  function handleExpandToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }

  return (
    <Wrapper
      {...(animationProps as Record<string, unknown>)}
      data-testid="session-item"
      className={cn(
        'group rounded-lg transition-colors duration-150',
        isActive
          ? 'bg-secondary text-foreground border-primary border-l-2'
          : 'hover:bg-secondary/50 border-l-2 border-transparent'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          onClick();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className="cursor-pointer px-3 py-2"
      >
        {/* Line 1: relative time + permission icon + expand */}
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1">{formatRelativeTime(session.updatedAt)}</span>
          <span className="flex flex-shrink-0 items-center gap-1">
            {isSkipMode && (
              <ShieldOff
                className="size-(--size-icon-xs) text-red-500"
                aria-label="Permissions skipped"
              />
            )}
            <button
              onClick={handleExpandToggle}
              className={cn(
                'rounded p-0.5 transition-all duration-150 max-md:hidden max-md:p-2',
                expanded
                  ? 'text-muted-foreground opacity-100'
                  : 'text-muted-foreground/60 hover:text-muted-foreground opacity-0 group-hover:opacity-100'
              )}
              aria-label="Session details"
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

        {/* Line 2: title */}
        <div className="text-muted-foreground/70 mt-0.5 truncate text-xs">{session.title}</div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="text-muted-foreground border-border/30 mx-2 space-y-1.5 border-t px-3 pt-2 pb-2 text-[11px]">
              <DetailRow label="Session ID" value={session.id} copyable />
              <DetailRow label="Created" value={formatTimestamp(session.createdAt)} />
              <DetailRow label="Updated" value={formatTimestamp(session.updatedAt)} />
              <DetailRow label="Permissions" value={isSkipMode ? 'Skip (unsafe)' : 'Default'} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Wrapper>
  );
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
      {copyable && <CopyButton text={value} label={label} />}
    </div>
  );
}
