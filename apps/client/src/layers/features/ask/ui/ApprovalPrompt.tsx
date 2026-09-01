import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useImperativeHandle,
  useCallback,
} from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, X, Shield, ShieldCheck } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { DENY_REASON_MAX_LENGTH } from '@dorkos/shared/schemas';
import { ToolArgumentsDisplay, cn, getToolLabel, getMcpServerBadge } from '@/layers/shared/lib';
import { Kbd, Button, Input, CompactResultRow } from '@/layers/shared/ui';
import { AskCard, WARN_AT_S, URGENT_AT_S } from './AskCard';
import { ASK_PARKED_LABEL } from '../lib/format-time-left';

// --- Animation constants (module-scope to avoid per-render allocation) ---

/** The answered card's confirmation beat, before it compresses out of the way. */
const confirmTransition = { duration: 0.12, ease: 'easeOut' as const } as const;

/** Reduced motion gets the end state with no travel and no time. */
const instantTransition = { duration: 0 } as const;

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

interface ApprovalPromptProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  /** Whether this is the active shortcut target */
  isActive?: boolean;
  /** Called after user approves or denies, to optimistically clear waiting state */
  onDecided?: () => void;
  /** React 19 ref-as-prop for imperative approve/deny control */
  ref?: React.Ref<ApprovalPromptHandle>;
  /** Server-provided approval timeout duration in milliseconds */
  timeoutMs?: number;
  /** Server timestamp (ms since epoch) when approval timer started — used for drift-free countdown */
  approvalStartedAt?: number;
  /**
   * Server-authoritative ms left before auto-deny, present only on recovery re-emit/pull.
   * When set, the deadline derives as `Date.now() + approvalRemainingMs` so a reconnect
   * resumes at the true offset instead of resetting from `approvalStartedAt + timeoutMs`.
   */
  approvalRemainingMs?: number;
  /**
   * True when the server already reports this prompt as PARKED: nobody answered
   * inside the budget, so `approvalRemainingMs` counts down to the four-hour
   * ceiling rather than to the ten-minute budget beside it. Read as a fact
   * rather than inferred, because inferring it is what drew "228:59 remaining"
   * on a card recovered mid-park.
   */
  approvalParked?: boolean;
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
  /**
   * Whether this session's runtime can deliver a free-text deny reason to the
   * agent (`RuntimeCapabilities.permissionModes.denyReason`). Defaults to
   * `true` — most runtimes have the channel. `false` (OpenCode: its respond
   * endpoint takes no free text) hides "Add a reason" and the field itself,
   * rather than offering an affordance that would silently go nowhere
   * (DOR-825).
   */
  allowsDenyReason?: boolean;
}

export interface ApprovalPromptHandle {
  approve: () => void;
  alwaysAllow: () => void;
  deny: () => void;
}

/**
 * Tool approval card rendered when the agent requests permission to use a tool.
 *
 * Supports imperative control via `ref` (approve/deny) for keyboard shortcut integration.
 * Shows a countdown timer when `timeoutMs` is provided, with warning phases at 2 min and 1 min.
 * Once that countdown runs out the card PARKS: the words say the agent is waiting, the bar
 * goes, and both answers stay live until the server withdraws the card (spec
 * `ask-parks-on-timeout`).
 */
export function ApprovalPrompt({
  sessionId,
  toolCallId,
  toolName,
  input,
  isActive = false,
  onDecided,
  ref,
  timeoutMs,
  approvalStartedAt,
  approvalRemainingMs,
  approvalParked,
  approvalTitle,
  approvalDisplayName,
  approvalDescription,
  approvalBlockedPath,
  approvalDecisionReason,
  approvalHasSuggestions,
  allowsDenyReason = true,
}: ApprovalPromptProps) {
  const transport = useTransport();
  const reducedMotion = useReducedMotion();
  const riskLevel = useMemo(() => classifyToolRisk(toolName), [toolName]);
  const badge = getMcpServerBadge(toolName);
  const rawLabel = getToolLabel(toolName, input);
  // Prefer SDK-provided display name, fall back to our own label
  const label = approvalDisplayName || rawLabel;
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The optional "why". Held in a ref as well as state so the deny handler —
  // which the keyboard shortcut also calls through an imperative handle — reads
  // the current text without being rebuilt on every keystroke.
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef('');
  // While the field holds focus, Enter belongs to it — so the card stops
  // advertising Enter as Approve. A hint for a shortcut that is not live is
  // worse than no hint.
  const [reasonFocused, setReasonFocused] = useState(false);
  const showKeyHints = isActive && !reasonFocused;

  // The clock this card anchors its deadline to, read once when the card mounts
  // and again only when the inputs that DEFINE the deadline change. Reading the
  // clock while rendering would re-anchor a countdown already running, since a
  // render can run more than once for the same state.
  const [anchor, setAnchor] = useState(() => Date.now());
  const anchored = useRef(false);
  useLayoutEffect(() => {
    if (!anchored.current) {
      // The mount's anchor is the `useState` initializer above.
      anchored.current = true;
      return;
    }
    setAnchor(Date.now());
  }, [timeoutMs, approvalStartedAt, approvalRemainingMs]);

  // What the interval below has counted down to, stamped with the deadline it
  // was counting to. The first value is derived rather than set from the effect,
  // so the card never paints a blank clock for a frame.
  const [tick, setTick] = useState<{ expiresAt: number; seconds: number } | null>(null);

  // ONE deadline for the whole card — the ticking text and the draining bar
  // both read it, so they cannot disagree. Priority:
  //   1. Recovery offset — `Date.now() + approvalRemainingMs` (server-authoritative
  //      remaining time on reconnect, so the countdown resumes without resetting).
  //   2. Drift-free start — `approvalStartedAt + timeoutMs` (live foreground turn).
  //   3. Local fallback — `Date.now() + timeoutMs`.
  //
  // Recomputed only when its inputs change, never per tick: the bar's anchor is
  // derived from it, and re-writing an animation's delay mid-flight restarts it.
  const deadline = useMemo(() => {
    // A parked prompt has no deadline left to draw: its remainder belongs to the
    // ceiling, not to the countdown, and the card says the agent is waiting.
    if (!timeoutMs || approvalParked === true) return null;
    const expiresAt =
      approvalRemainingMs !== undefined
        ? anchor + approvalRemainingMs
        : approvalStartedAt
          ? approvalStartedAt + timeoutMs
          : anchor + timeoutMs;
    // How much of the budget is already gone. The bar is a CSS animation over
    // the FULL budget, so a card mounted mid-wait — a reload, a second window,
    // a card scrolled back into view — has to seek the animation forward by
    // this much or it draws a nearly-full bar over an ask with a minute left.
    const elapsedMs = Math.min(timeoutMs, Math.max(0, timeoutMs - (expiresAt - anchor)));
    return { expiresAt, elapsedMs };
  }, [anchor, timeoutMs, approvalStartedAt, approvalRemainingMs, approvalParked]);

  // The countdown itself: derived from the deadline, and re-derived every second
  // by the interval below. A tick stamped with a different deadline is stale, so
  // a re-anchored card falls straight back to the derived value.
  const secondsRemaining =
    decided || !timeoutMs || !deadline
      ? null
      : tick !== null && tick.expiresAt === deadline.expiresAt
        ? tick.seconds
        : Math.max(0, Math.ceil((deadline.expiresAt - anchor) / 1000));

  useEffect(() => {
    if (decided || !timeoutMs || !deadline) return;
    const { expiresAt } = deadline;

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setTick({ expiresAt, seconds: remaining });

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutMs, deadline, decided]);

  // Parked: the agent is holding the tool call and waiting, either because the
  // server already said so or because this card's own countdown ran out.
  const parked = approvalParked === true || secondsRemaining === 0;

  // A countdown that reaches zero is a WAIT, not a death. The agent holds the
  // tool call until somebody answers or its four-hour ceiling fires, and only
  // then does the server withdraw the card and write the receipt (spec
  // `ask-parks-on-timeout`). So this card keeps its Approve and Deny, and says
  // it is waiting where the clock was. Deciding for the agent here is what made
  // the transcript claim a refusal nobody gave.

  // Screen reader announcements at threshold crossings. An answered card has
  // nothing left to warn about, so the region empties the moment it settles —
  // which also keeps it empty at rest, the state a live region has to be in for
  // its next change to be heard as news.
  //
  // Written as BANDS rather than exact seconds, which is what makes the sentence
  // persist between crossings the way the latched state it replaces did: a
  // region that emptied itself a second after speaking would leave a reader who
  // asked to re-read it with nothing there. Bands also survive a skipped second
  // — a backgrounded tab that jumps 121 → 119 still gets the warning, where an
  // exact match got silence.
  const announcement =
    decided || secondsRemaining === null
      ? ''
      : secondsRemaining <= 0
        ? 'Nobody answered. The agent is waiting for you.'
        : secondsRemaining <= URGENT_AT_S
          ? 'Urgent: 1 minute to approve or deny.'
          : secondsRemaining <= WARN_AT_S
            ? 'Tool approval required. 2 minutes remaining.'
            : '';

  // NOTE: the RESOLUTION is deliberately not announced from here. Answering
  // resolves the interaction, which clears the input zone and unmounts this
  // component, so anything written to a region it owns is removed in the same
  // commit and never read. That announcement lives with the transcript, which
  // outlives the card — `model/stream/use-approval-announcer`.

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
        setError('Approval request failed. Try again.');
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
        setError('Always Allow request failed. Try again.');
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
      // Whatever is in the field rides along, including from the Esc shortcut —
      // a person who typed a reason and then hit Esc still meant to send it.
      await transport.denyTool(sessionId, toolCallId, reasonRef.current.trim() || undefined);
      setDecided('denied');
      onDecided?.();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INTERACTION_ALREADY_RESOLVED') {
        setDecided('denied');
        onDecided?.();
      } else {
        console.error('Deny failed:', err);
        setError('Deny request failed. Try again.');
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

  /**
   * The countdown-phase warnings. Rendered OUTSIDE the decided/undecided branch
   * so the region is one continuous node for as long as the card exists —
   * inside the branch, a warning issued as the card settles was written to a
   * node React removed in the same paint.
   */
  const liveRegion = (
    <span role="status" aria-live="assertive" aria-atomic="true" className="sr-only">
      {announcement}
    </span>
  );

  if (decided) {
    const isApproved = decided === 'approved';
    return (
      <>
        <motion.div
          // The card confirms and compresses; the record of this answer is the
          // receipt line that rises into the transcript, not this row.
          initial={reducedMotion ? false : { opacity: 0, scaleY: 0.9 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={reducedMotion ? instantTransition : confirmTransition}
          style={{ originY: 0 }}
        >
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
          />
        </motion.div>
        {liveRegion}
      </>
    );
  }

  return (
    <>
      <AskCard.Root
        isActive={isActive}
        isResolved={!!decided}
        // `A` allows and `D` denies, and ONLY while focus is inside this card.
        // ADDITIVE to the shipped keyboard model, not a replacement: the active
        // card in the input zone still answers to bare Enter and Esc through
        // `useInteractiveShortcuts`, and those are the keys the hints below
        // advertise because those are the ones that work without focusing the
        // card first. See {@link AskCardRoot} for why the letters are card-local.
        onAllow={handleApprove}
        onDeny={handleDeny}
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
          <AskCard.Headline className="font-semibold">
            {approvalTitle || 'Tool approval required'}
          </AskCard.Headline>
        </div>

        {/* SDK-provided context: description, decision reason, blocked path */}
        {(approvalDescription || approvalDecisionReason || approvalBlockedPath) && (
          <AskCard.Detail className="mb-2">
            {approvalDescription && <p>{approvalDescription}</p>}
            {approvalDecisionReason && !approvalDescription && <p>{approvalDecisionReason}</p>}
            {approvalBlockedPath && <p className="font-mono">Path: {approvalBlockedPath}</p>}
          </AskCard.Detail>
        )}

        {/* The draining bar and the words beside it. The bar is decoration and
            says so; the accessible countdown is the text, which is why the text
            is present from the start rather than fading in at two minutes — a
            reader who cannot see the bar had nothing until then. */}
        {(timeoutMs || parked) && !decided && (
          <div className="mb-2">
            <AskCard.Countdown
              // Parked either way it can be known — the server said so on a card
              // recovered mid-park, or this card's own clock ran out while
              // somebody watched. Both read identically: no bar, and the words
              // say the agent is waiting rather than counting anything down.
              secondsLeft={parked ? null : secondsRemaining}
              {...(parked ? {} : { timeoutMs })}
              elapsedMs={deadline?.elapsedMs ?? 0}
              label={
                parked
                  ? ASK_PARKED_LABEL
                  : secondsRemaining === null
                    ? ''
                    : `${formatCountdown(secondsRemaining)} remaining`
              }
            />
          </div>
        )}

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
        {/* The optional "why". Hidden until asked for, so the fast path — read
            the command, allow or deny — is untouched; revealed, it is one line
            and the agent gets it with the refusal. Withheld entirely on a
            runtime with no channel for one (DOR-825) — the field would
            otherwise take a person's words and deliver them nowhere. */}
        {allowsDenyReason && reasonOpen && (
          <div className="mb-2">
            <Input
              autoFocus
              // Opts this field out of the card's document-wide Enter shortcut,
              // which would otherwise APPROVE the call being refused.
              data-approval-field=""
              value={reason}
              maxLength={DENY_REASON_MAX_LENGTH}
              disabled={responding}
              onFocus={() => setReasonFocused(true)}
              onBlur={() => setReasonFocused(false)}
              onChange={(e) => {
                setReason(e.target.value);
                reasonRef.current = e.target.value;
              }}
              onKeyDown={(e) => {
                // Enter sends the denial with this reason. The card's global
                // Enter shortcut stands down while a field has focus, so this
                // cannot approve by accident.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleDeny();
                }
              }}
              placeholder="Why not? The agent gets this and can try another way"
              aria-label="Reason for denying"
              className="text-xs"
            />
          </div>
        )}
        <AskCard.Actions>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={responding}
            className="transition-opacity duration-150"
          >
            <Check className="size-(--size-icon-xs)" /> Approve
            {showKeyHints && <Kbd className="ml-1.5">Enter</Kbd>}
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
              {showKeyHints && <Kbd className="ml-1.5">Shift+Enter</Kbd>}
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
          {allowsDenyReason && !reasonOpen && (
            <button
              type="button"
              onClick={() => setReasonOpen(true)}
              disabled={responding}
              className={cn(
                'text-muted-foreground hover:text-foreground text-2xs rounded underline',
                'focus-visible:ring-ring/50 underline-offset-2 focus-visible:ring-2',
                'focus-visible:outline-none disabled:opacity-50'
              )}
            >
              Add a reason
            </button>
          )}
        </AskCard.Actions>
      </AskCard.Root>
      {liveRegion}
    </>
  );
}
