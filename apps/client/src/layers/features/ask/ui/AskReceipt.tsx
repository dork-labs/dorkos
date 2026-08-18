import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, Clock, X } from 'lucide-react';
import type { ToolApprovalOutcome } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';

/** One answered request inside a receipt. */
export interface AskReceiptItem {
  /** The interaction's tool-call id — the stable key. */
  toolCallId: string;
  /** Human summary of what was asked for, e.g. `Run "npm test"`. */
  label: string;
}

interface AskReceiptProps {
  /** How the request(s) were answered. */
  outcome: ToolApprovalOutcome;
  /** The answered requests. More than one renders the combined line. */
  items: AskReceiptItem[];
  /** Server epoch ms when the answer landed. Omitted when the runtime cannot say. */
  resolvedAt?: number;
  /** Server epoch ms when the request was made — with `resolvedAt`, how long it waited. */
  startedAt?: number;
  /**
   * Whether the person's words were delivered to the agent with a denial. Set
   * only from what the server said it delivered, so the clause below is a
   * report and never a guess.
   */
  reasonGiven?: boolean;
  className?: string;
}

/**
 * How far the receipt travels as it rises into the transcript, in pixels.
 * Small on purpose: the line settles into place, it does not fly.
 */
const RISE_PX = 8;

/** One decelerating ease, well inside the 450ms the whole settle is allowed. */
const RISE_TRANSITION = { duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const;

/** Reduced motion gets the same end state with no travel and no time. */
const INSTANT_TRANSITION = { duration: 0 } as const;

/** Format a wait as `m:ss`, or `Ns` under a minute. */
function formatWaited(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Clock time for the receipt, in the reader's locale (e.g. `2:41 PM`). */
function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `n actions` / `1 action`. */
function actionCount(n: number): string {
  return `${n} action${n === 1 ? '' : 's'}`;
}

/**
 * A one-line record of an answered permission request, sitting at the
 * interaction's own place in the transcript.
 *
 * The pending card is a question; this is the answer, kept. It is deliberately
 * quiet — muted single line, no card chrome — because its job is to be findable
 * later, not to compete with the conversation now.
 *
 * Every field comes from the projected event stream, so a re-render, a replay,
 * or another window reconstructs the identical line — and the record is
 * permanent, not session-scoped: the server keeps the answer with the turn it
 * gated and puts it back into history, so reopening the conversation tomorrow
 * shows the same line in the same place.
 */
export function AskReceipt({
  outcome,
  items,
  resolvedAt,
  startedAt,
  reasonGiven,
  className,
}: AskReceiptProps) {
  const reducedMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);

  const count = items.length;
  const isBatch = count > 1;
  const subject = isBatch ? actionCount(count) : items[0]?.label;

  // An expiry states how long the request waited before the system answered for
  // you. Derived from the interaction's own timer (asked → answered), never a
  // hardcoded duration, so a changed approval budget reads correctly here.
  const waitedMs =
    resolvedAt !== undefined && startedAt !== undefined
      ? Math.max(0, resolvedAt - startedAt)
      : null;

  const Icon = outcome === 'allowed' ? Check : outcome === 'denied' ? X : Clock;
  const iconClass =
    outcome === 'allowed'
      ? 'text-status-success'
      : outcome === 'denied'
        ? 'text-status-error'
        : 'text-muted-foreground';

  return (
    <motion.div
      data-testid="approval-receipt"
      data-outcome={outcome}
      data-count={count}
      initial={reducedMotion ? false : { opacity: 0, y: RISE_PX }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? INSTANT_TRANSITION : RISE_TRANSITION}
      className={cn('text-muted-foreground my-1 text-xs', className)}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn('size-(--size-icon-xs) shrink-0', iconClass)} aria-hidden="true" />
        <span className="min-w-0 truncate">
          {outcome === 'expired' ? (
            <>
              Expired — {isBatch ? `${subject} ` : ''}denied
              {waitedMs !== null && ` after ${formatWaited(waitedMs)}`}
            </>
          ) : (
            <>
              You {outcome === 'allowed' ? 'allowed' : 'denied'}{' '}
              {isBatch ? subject : <span className="font-mono">{subject}</span>}
              {/* Only when the reason actually reached the agent. A refusal it
                  can explain is one it can work around instead of retrying. */}
              {outcome === 'denied' && reasonGiven === true && <> — agent was told why</>}
            </>
          )}
        </span>
        {resolvedAt !== undefined && (
          <time
            dateTime={new Date(resolvedAt).toISOString()}
            className="ml-auto shrink-0 tabular-nums opacity-70"
          >
            {formatClock(resolvedAt)}
          </time>
        )}
        {isBatch && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className={cn(
              'hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded underline',
              'underline-offset-2 focus-visible:ring-2 focus-visible:outline-none'
            )}
          >
            {expanded ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {isBatch && expanded && (
        <ul data-testid="approval-receipt-items" className="mt-1 ml-6 space-y-0.5">
          {items.map((item) => (
            <li key={item.toolCallId} className="truncate font-mono">
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}
