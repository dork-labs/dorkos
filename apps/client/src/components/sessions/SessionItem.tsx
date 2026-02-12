import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Copy, Check, ShieldOff } from 'lucide-react';
import type { Session } from '@lifeos/shared/types';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/session-utils';
import { useIsMobile } from '@/hooks/use-is-mobile';

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

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API not available
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="p-0.5 max-md:p-2 rounded hover:bg-secondary/80 text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-100"
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
  const isMobile = useIsMobile();
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
      {...(animationProps as any)}
      className={cn(
        'group rounded-lg transition-colors duration-150',
        isActive
          ? 'bg-secondary text-foreground border-l-2 border-primary'
          : 'hover:bg-secondary/50 border-l-2 border-transparent'
      )}
    >
      <div
        onClick={() => {
          if (isMobile) {
            setExpanded((prev) => !prev);
          }
          onClick();
        }}
        className="px-3 py-2 cursor-pointer"
      >
        {/* Line 1: relative time + permission icon + expand */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="flex-1 min-w-0">
            {formatRelativeTime(session.updatedAt)}
          </span>
          <span className="flex items-center gap-1 flex-shrink-0">
            {isSkipMode && (
              <ShieldOff
                className="size-(--size-icon-xs) text-red-500"
                aria-label="Permissions skipped"
              />
            )}
            <button
              onClick={handleExpandToggle}
              className={cn(
                'p-0.5 max-md:p-2 max-md:hidden rounded transition-all duration-150',
                expanded
                  ? 'opacity-100 text-muted-foreground'
                  : 'opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-muted-foreground'
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
        <div className="text-xs text-muted-foreground/70 truncate mt-0.5">
          {session.title}
        </div>
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
            <div className="px-3 pb-2 pt-2 space-y-1.5 text-[11px] text-muted-foreground border-t border-border/30 mx-2">
              <DetailRow label="Session ID" value={session.id} copyable />
              <DetailRow label="Created" value={formatTimestamp(session.createdAt)} />
              <DetailRow label="Updated" value={formatTimestamp(session.updatedAt)} />
              <DetailRow
                label="Permissions"
                value={isSkipMode ? 'Skip (unsafe)' : 'Default'}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Wrapper>
  );
}

function DetailRow({ label, value, copyable = false }: { label: string; value: string; copyable?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground/60 flex-shrink-0 w-16">{label}</span>
      <span className="flex-1 min-w-0 font-mono truncate select-all">{value}</span>
      {copyable && <CopyButton text={value} label={label} />}
    </div>
  );
}
