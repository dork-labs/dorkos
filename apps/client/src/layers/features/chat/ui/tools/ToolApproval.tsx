import { useState, useEffect, useRef, useMemo, useImperativeHandle, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, X, Shield, ShieldCheck } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { ToolArgumentsDisplay, cn, getToolLabel, getMcpServerBadge } from '@/layers/shared/lib';
import { Kbd, Button } from '@/layers/shared/ui';
import { CompactResultRow, InteractiveCard } from '../primitives';

// --- Animation constants (module-scope to avoid per-render allocation) ---

const fadeTransition = { duration: 0.15, ease: 'easeOut' as const } as const;

const WARNING_THRESHOLD_S = 120; // 2 minutes — amber
const URGENT_THRESHOLD_S = 60; // 1 minute — red

type ApprovalPhase = 'normal' | 'warning' | 'urgent' | 'expired';

// --- Risk classification for visual differentiation ---

type RiskLevel = 'high' | 'medium' | 'low';

/** Tools that can modify the filesystem, execute commands, or have side effects. */
const HIGH_RISK_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);

/** Tools that modify state but with more constrained scope. */
const MEDIUM_RISK_TOOLS = new Set(['WebFetch', 'WebSearch']);

function classifyToolRisk(toolName: string): RiskLevel {
  // Strip MCP prefix for classification — mcp__server__tool → tool
  const baseName = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  if (HIGH_RISK_TOOLS.has(baseName) || HIGH_RISK_TOOLS.has(toolName)) return 'high';
  if (MEDIUM_RISK_TOOLS.has(baseName) || MEDIUM_RISK_TOOLS.has(toolName)) return 'medium';
  // MCP tools from unknown servers are medium risk by default
  if (toolName.startsWith('mcp__')) return 'medium';
  return 'low';
}

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
  if (m > 0)
    return `${m} minute${m !== 1 ? 's' : ''} and ${s} second${s !== 1 ? 's' : ''} remaining`;
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
  /** Server timestamp (ms since epoch) when approval timer started — used for drift-free countdown */
  approvalStartedAt?: number;
  /** SDK-provided full permission prompt sentence */
  approvalTitle?: string;
  /** SDK-provided short noun phrase for the tool action */
  approvalDisplayName?: string;
  /** SDK-provided human-readable subtitle */
  approvalDescription?: string;
  /** File path that triggered the permission request */
  approvalBlockedPath?: string;
  /** Why this permission request was triggered */
  approvalDecisionReason?: string;
  /** Whether "Always Allow" permission updates are available */
  approvalHasSuggestions?: boolean;
}

export interface ToolApprovalHandle {
  approve: () => void;
  alwaysAllow: () => void;
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
  approvalStartedAt,
  approvalTitle,
  approvalDisplayName,
  approvalDescription,
  approvalBlockedPath,
  approvalDecisionReason,
  approvalHasSuggestions,
}: ToolApprovalProps) {
  const transport = useTransport();
  const riskLevel = useMemo(() => classifyToolRisk(toolName), [toolName]);
  const badge = getMcpServerBadge(toolName);
  const rawLabel = getToolLabel(toolName, input);
  // Prefer SDK-provided display name, fall back to our own label
  const label = approvalDisplayName || rawLabel;
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Countdown state
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const timedOut = useRef(false);
  const [announcement, setAnnouncement] = useState('');

  // Initialize countdown from server's startedAt (drift-free) or fall back to local clock
  useEffect(() => {
    if (decided || !timeoutMs) return;

    const expiresAt = approvalStartedAt ? approvalStartedAt + timeoutMs : Date.now() + timeoutMs;
    setSecondsRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutMs, approvalStartedAt, decided]);

  // Timeout detection — transition to denied state and clear active interaction
  useEffect(() => {
    if (secondsRemaining === 0 && !decided) {
      timedOut.current = true;
      setDecided('denied');
      onDecided?.();
    }
  }, [secondsRemaining, decided, onDecided]);

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
    setError(null);
    try {
      await transport.approveTool(sessionId, toolCallId);
      setDecided('approved');
      onDecided?.();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INTERACTION_ALREADY_RESOLVED') {
        setDecided('approved');
        onDecided?.();
      } else {
        console.error('Approval failed:', err);
        setError('Approval request failed — try again');
      }
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  const handleAlwaysAllow = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    setError(null);
    try {
      await transport.approveTool(sessionId, toolCallId, true);
      setDecided('approved');
      onDecided?.();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INTERACTION_ALREADY_RESOLVED') {
        setDecided('approved');
        onDecided?.();
      } else {
        console.error('Always Allow failed:', err);
        setError('Always Allow request failed — try again');
      }
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  const handleDeny = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    setError(null);
    try {
      await transport.denyTool(sessionId, toolCallId);
      setDecided('denied');
      onDecided?.();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INTERACTION_ALREADY_RESOLVED') {
        setDecided('denied');
        onDecided?.();
      } else {
        console.error('Deny failed:', err);
        setError('Deny request failed — try again');
      }
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
      alwaysAllow() {
        handleAlwaysAllow();
      },
      deny() {
        handleDeny();
      },
    }),
    [handleApprove, handleAlwaysAllow, handleDeny]
  );

  if (decided) {
    const isApproved = decided === 'approved';
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fadeTransition}>
        <CompactResultRow
          data-testid="tool-approval-decided"
          data-decision={decided}
          icon={
            isApproved ? (
              <Check className="text-status-success size-(--size-icon-sm) shrink-0" />
            ) : (
              <X className="text-status-error size-(--size-icon-sm) shrink-0" />
            )
          }
          label={<span className="text-3xs font-mono">{label}</span>}
          trailing={
            <span
              className={cn(
                'text-2xs rounded-full px-1.5 py-0.5 font-medium',
                isApproved
                  ? 'bg-status-success-bg text-status-success-fg'
                  : 'bg-status-error-bg text-status-error-fg'
              )}
            >
              {isApproved ? 'Approved' : 'Denied'}
            </span>
          }
        >
          {decided === 'denied' && timedOut.current && (
            <p className="text-2xs text-muted-foreground mt-1">
              Auto-denied — approval timed out after {Math.ceil((timeoutMs ?? 0) / 60000)} minutes.
              The agent continued without this tool.
            </p>
          )}
        </CompactResultRow>
      </motion.div>
    );
  }

  return (
    <InteractiveCard
      isActive={isActive}
      isResolved={!!decided}
      className="my-1"
      data-testid="tool-approval"
    >
      <div className="mb-1 flex items-center gap-2">
        <Shield
          className={cn(
            'size-(--size-icon-md)',
            riskLevel === 'high' && 'text-status-error',
            riskLevel === 'medium' && 'text-status-warning',
            riskLevel === 'low' && 'text-muted-foreground'
          )}
        />
        <span className="font-semibold">{approvalTitle || 'Tool approval required'}</span>
      </div>

      {/* SDK-provided context: description, decision reason, blocked path */}
      {(approvalDescription || approvalDecisionReason || approvalBlockedPath) && (
        <div className="text-muted-foreground text-2xs mb-2 space-y-0.5">
          {approvalDescription && <p>{approvalDescription}</p>}
          {approvalDecisionReason && !approvalDescription && <p>{approvalDecisionReason}</p>}
          {approvalBlockedPath && <p className="font-mono">Path: {approvalBlockedPath}</p>}
        </div>
      )}

      {/* Progress bar — drains via CSS animation over timeoutMs */}
      {timeoutMs && !decided && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.ceil(timeoutMs / 1000)}
          aria-valuenow={secondsRemaining ?? 0}
          aria-valuetext={formatAriaTimeRemaining(secondsRemaining)}
          className="bg-muted mb-2 h-1 w-full overflow-hidden rounded-full"
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

      {/* Text countdown — fades in at warning threshold, updates through urgent */}
      <AnimatePresence>
        {(phase === 'warning' || phase === 'urgent') && secondsRemaining !== null && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={fadeTransition}
            className="mb-2"
          >
            <span
              className={cn(
                'text-2xs tabular-nums',
                phase === 'warning' && 'text-status-warning',
                phase === 'urgent' && 'text-status-error'
              )}
            >
              {formatCountdown(secondsRemaining)} remaining
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mb-2 flex items-center gap-1.5">
        {badge && (
          <span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium">
            {badge}
          </span>
        )}
        <span className="font-mono text-xs">{label}</span>
      </div>
      {input && (
        <div className="bg-muted mb-3 rounded p-2">
          <ToolArgumentsDisplay toolName={toolName} input={input} />
        </div>
      )}
      {error && <p className="text-status-error text-2xs mb-2">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={handleApprove}
          disabled={responding}
          className="transition-opacity duration-150"
        >
          <Check className="size-(--size-icon-xs)" /> Approve
          {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
        </Button>
        {approvalHasSuggestions && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAlwaysAllow}
            disabled={responding}
            className="transition-opacity duration-150"
          >
            <ShieldCheck className="size-(--size-icon-xs)" /> Always Allow
            {isActive && <Kbd className="ml-1.5">Shift+Enter</Kbd>}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={handleDeny}
          disabled={responding}
          className="transition-opacity duration-150"
        >
          <X className="size-(--size-icon-xs)" /> Deny
          {isActive && <Kbd className="ml-1.5">Esc</Kbd>}
        </Button>
      </div>

      {/* Screen reader announcements — only at threshold crossings */}
      <span role="status" aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </InteractiveCard>
  );
}
