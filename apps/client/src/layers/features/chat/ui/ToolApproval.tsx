import { useState, useEffect, useRef, useMemo, useImperativeHandle, useCallback } from 'react';
import { Check, X, Shield } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { ToolArgumentsDisplay, cn } from '@/layers/shared/lib';
import { Kbd, Button } from '@/layers/shared/ui';
import { approvalState } from './message/message-variants';

const WARNING_THRESHOLD_S = 120; // 2 minutes — amber
const URGENT_THRESHOLD_S = 60; // 1 minute — red

type ApprovalPhase = 'normal' | 'warning' | 'urgent' | 'expired';

/** Format seconds as m:ss or Ns for the visible countdown. */
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Format seconds as human-readable string for aria-valuetext. */
function formatAriaTimeRemaining(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds <= 0) return 'Expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m} minute${m !== 1 ? 's' : ''} and ${s} second${s !== 1 ? 's' : ''} remaining`;
  return `${s} second${s !== 1 ? 's' : ''} remaining`;
}

interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  /** Whether this is the active shortcut target */
  isActive?: boolean;
  /** Called after user approves or denies, to optimistically clear waiting state */
  onDecided?: () => void;
  /** React 19 ref-as-prop for imperative approve/deny control */
  ref?: React.Ref<ToolApprovalHandle>;
  /** Server-provided approval timeout duration in milliseconds */
  timeoutMs?: number;
}

export interface ToolApprovalHandle {
  approve: () => void;
  deny: () => void;
}

/**
 * Tool approval card rendered when the agent requests permission to use a tool.
 *
 * Supports imperative control via `ref` (approve/deny) for keyboard shortcut integration.
 * Shows a countdown timer when `timeoutMs` is provided, with warning phases at 2 min and 1 min.
 */
export function ToolApproval({
  sessionId,
  toolCallId,
  toolName,
  input,
  isActive = false,
  onDecided,
  ref,
  timeoutMs,
}: ToolApprovalProps) {
  const transport = useTransport();
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);

  // Countdown state
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const timedOut = useRef(false);
  const [announcement, setAnnouncement] = useState('');

  // Initialize countdown from timeoutMs
  useEffect(() => {
    if (decided || !timeoutMs) return;

    const expiresAt = Date.now() + timeoutMs;
    setSecondsRemaining(Math.ceil(timeoutMs / 1000));

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutMs, decided]);

  // Timeout detection — transition to denied state
  useEffect(() => {
    if (secondsRemaining === 0 && !decided) {
      timedOut.current = true;
      setDecided('denied');
    }
  }, [secondsRemaining, decided]);

  // Screen reader announcements at threshold crossings
  useEffect(() => {
    if (secondsRemaining === WARNING_THRESHOLD_S) {
      setAnnouncement('Tool approval required. 2 minutes remaining.');
    } else if (secondsRemaining === URGENT_THRESHOLD_S) {
      setAnnouncement('Urgent: 1 minute to approve or deny.');
    } else if (secondsRemaining === 0) {
      setAnnouncement('Tool approval timed out. Execution denied.');
    }
  }, [secondsRemaining]);

  const phase: ApprovalPhase = useMemo(() => {
    if (secondsRemaining === null) return 'normal';
    if (secondsRemaining <= 0) return 'expired';
    if (secondsRemaining <= URGENT_THRESHOLD_S) return 'urgent';
    if (secondsRemaining <= WARNING_THRESHOLD_S) return 'warning';
    return 'normal';
  }, [secondsRemaining]);

  const handleApprove = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.approveTool(sessionId, toolCallId);
      setDecided('approved');
      onDecided?.();
    } catch (err) {
      console.error('Approval failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  const handleDeny = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.denyTool(sessionId, toolCallId);
      setDecided('denied');
      onDecided?.();
    } catch (err) {
      console.error('Deny failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  useImperativeHandle(
    ref,
    () => ({
      approve() {
        handleApprove();
      },
      deny() {
        handleDeny();
      },
    }),
    [handleApprove, handleDeny]
  );

  if (decided) {
    const isApproved = decided === 'approved';
    return (
      <div
        className="bg-muted/50 rounded-msg-tool border px-3 py-1 text-sm shadow-msg-tool transition-all duration-150"
        data-testid="tool-approval-decided"
        data-decision={decided}
      >
        <div className="flex items-center gap-2">
          {isApproved ? (
            <Check className="size-(--size-icon-sm) shrink-0 text-status-success" />
          ) : (
            <X className="size-(--size-icon-sm) shrink-0 text-status-error" />
          )}
          <span className="font-mono text-3xs">{toolName}</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-2xs font-medium',
              isApproved
                ? 'bg-status-success-bg text-status-success-fg'
                : 'bg-status-error-bg text-status-error-fg'
            )}
          >
            {isApproved ? 'Approved' : 'Denied'}
          </span>
        </div>
        {decided === 'denied' && timedOut.current && (
          <p className="text-2xs text-muted-foreground mt-1">
            Auto-denied — approval timed out after {Math.ceil((timeoutMs ?? 0) / 60000)} minutes. The agent continued
            without this tool.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'my-1 rounded-msg-tool border p-3 text-sm transition-all duration-200',
        approvalState({ state: 'pending' }),
        isActive && 'ring-2 ring-status-warning/30'
      )}
      data-testid="tool-approval"
    >
      <div className="mb-2 flex items-center gap-2">
        <Shield className="size-(--size-icon-md) text-status-warning" />
        <span className="font-semibold">Tool approval required</span>
      </div>

      {/* Progress bar — drains via CSS animation over timeoutMs */}
      {timeoutMs && !decided && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.ceil(timeoutMs / 1000)}
          aria-valuenow={secondsRemaining ?? 0}
          aria-valuetext={formatAriaTimeRemaining(secondsRemaining)}
          className="mb-2 h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full transition-colors duration-500',
              phase === 'normal' && 'bg-muted-foreground/30',
              phase === 'warning' && 'bg-status-warning',
              phase === 'urgent' && 'bg-status-error',
              'motion-safe:animate-drain'
            )}
            style={{
              animationDuration: `${timeoutMs}ms`,
              animationTimingFunction: 'linear',
              animationFillMode: 'forwards',
            }}
          />
        </div>
      )}

      {/* Text countdown — only visible in warning/urgent phases (last 2 minutes) */}
      {(phase === 'warning' || phase === 'urgent') && secondsRemaining !== null && (
        <div className="mb-2">
          <span
            className={cn(
              'text-2xs tabular-nums',
              phase === 'warning' && 'text-status-warning',
              phase === 'urgent' && 'text-status-error'
            )}
          >
            {formatCountdown(secondsRemaining)} remaining
          </span>
        </div>
      )}

      <div className="mb-2 font-mono text-xs">{toolName}</div>
      {input && (
        <div className="bg-muted mb-3 rounded p-2">
          <ToolArgumentsDisplay toolName={toolName} input={input} />
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleApprove}
          disabled={responding}
          className="bg-status-success text-white hover:bg-status-success/90"
        >
          <Check className="size-(--size-icon-xs)" /> Approve
          {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleDeny}
          disabled={responding}
        >
          <X className="size-(--size-icon-xs)" /> Deny
          {isActive && <Kbd className="ml-1.5">Esc</Kbd>}
        </Button>
      </div>

      {/* Screen reader announcements — only at threshold crossings */}
      <span role="status" aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
