/**
 * The chrome every Ask is drawn in — the one card, wherever it appears.
 *
 * An **Ask** is a prompt an agent is parked on: a tool approval, a question, or
 * an MCP elicitation. A capability approval (`features/approvals`) is a
 * different object — persisted, ULID-keyed, a two-hour window — and its DATA is
 * deliberately not merged with this. What the two share is entirely
 * presentational, so the chrome is here and both adopt it.
 *
 * The parts are composed, never configured: a caller picks the ones its prompt
 * actually has something to put in, and a prompt that carries no detail simply
 * draws no {@link AskCardDetail}. The card never invents a diff stat or a
 * preview the prompt did not supply.
 *
 * @module features/ask/ui/AskCard
 */
import { useCallback, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  AgentAvatar,
  useAgentVisual,
  type AgentAvatarProps,
  type AgentVisualSource,
} from '@/layers/entities/agent';

/**
 * The arrival gesture: the message-entrance grammar, unchanged.
 *
 * A card that lands while somebody is typing must read as a thing that appeared
 * beside them, not as a thing that grabbed them — so it fades and rises 8px and
 * does nothing else. Focus is never taken (see {@link AskCardRoot}).
 */
const ENTRANCE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring', stiffness: 320, damping: 28 },
} as const;

/** Reduced motion gets the end state, with no travel and no time. */
const ENTRANCE_REDUCED = {
  initial: false,
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0 },
} as const;

/** How urgent the countdown is. Drives colour, and nothing else. */
export type AskUrgency = 'neutral' | 'warning' | 'urgent' | 'expired';

/** Seconds left at which the countdown turns amber. */
export const WARN_AT_S = 120;

/** Seconds left at which it turns red. */
export const URGENT_AT_S = 60;

/**
 * Which band a countdown is in.
 *
 * Thresholds from `research/20260316_tool_approval_timeout_visibility_ux.md`:
 * neutral above two minutes, warn at two minutes, urgent at one.
 *
 * @param secondsLeft - Seconds until the prompt auto-denies, or `null` when it
 *   has no deadline at all.
 */
export function askUrgency(secondsLeft: number | null): AskUrgency {
  if (secondsLeft === null) return 'neutral';
  if (secondsLeft <= 0) return 'expired';
  if (secondsLeft <= URGENT_AT_S) return 'urgent';
  if (secondsLeft <= WARN_AT_S) return 'warning';
  return 'neutral';
}

/** What {@link AskCardRoot} takes. */
export interface AskCardRootProps {
  /** The card's body — the parts below, in whatever order the prompt needs. */
  children: ReactNode;
  /** Whether this card is the keyboard shortcut's current target. */
  isActive?: boolean;
  /** Whether it has been answered, so it is no longer dimmed as background. */
  isResolved?: boolean;
  /**
   * Allow, when this card can be answered with one key. Fires on `A` — and only
   * while focus is inside the card, never as a document-level hotkey.
   */
  onAllow?: () => void;
  /** Deny, on `D`, under the same rule. */
  onDeny?: () => void;
  /** Extra chrome from the caller — margins, width. */
  className?: string;
  /** React 19 ref-as-prop, so a surface can move focus onto the card. */
  ref?: Ref<HTMLDivElement>;
  'data-testid'?: string;
  [key: `data-${string}`]: string | boolean | undefined;
}

/** Fields that own their own keystrokes; `A` and `D` are letters in there. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The card itself: the border, the arrival, and the two one-key answers.
 *
 * **`A` and `D` are handled here, on the card, and that is the whole design.**
 * They are React key handlers on a focusable element, so they fire only when
 * focus is inside this card — an Ask that lands while somebody is typing in the
 * composer cannot swallow the letter `a`. A document-level hotkey could not make
 * that promise, and this is the one promise the design screen asked for by name.
 *
 * The card never takes focus on arrival. `⌘⇧A` moves focus here deliberately;
 * nothing else does.
 */
export function AskCardRoot({
  children,
  isActive = false,
  isResolved = false,
  onAllow,
  onDeny,
  className,
  ref,
  ...dataProps
}: AskCardRootProps) {
  const reducedMotion = useReducedMotion();
  const answerable = onAllow !== undefined || onDeny !== undefined;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingInto(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'a' && onAllow) {
        event.preventDefault();
        onAllow();
      } else if (key === 'd' && onDeny) {
        event.preventDefault();
        onDeny();
      }
    },
    [onAllow, onDeny]
  );

  const motionProps = reducedMotion ? ENTRANCE_REDUCED : ENTRANCE;

  return (
    <motion.div
      ref={ref}
      data-slot="ask-card"
      // Mirrors the reduced-motion branch onto the DOM, because the test harness
      // strips motion props — the same trick the live lane uses.
      data-ask-motion={reducedMotion ? 'off' : 'on'}
      {...motionProps}
      {...(answerable ? { tabIndex: -1, onKeyDown } : {})}
      className={cn(
        'border-status-info bg-muted/50 rounded-msg-tool border-l-2 p-3 text-sm transition-all duration-200',
        isActive && 'ring-ring/30 ring-2',
        !isActive && !isResolved && 'opacity-60',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
      {...dataProps}
    >
      {children}
    </motion.div>
  );
}

/** What {@link AskCardFace} takes. */
export interface AskCardFaceProps {
  /** The session's working directory — the fallback identity every prompt carries. */
  cwd: string;
  /** The agent behind that directory, when the surface holds the roster. */
  agent?: AgentVisualSource | null;
  /** Diameter, in the four sizes the cockpit draws identities at. */
  size?: AgentAvatarProps['size'];
  className?: string;
}

/**
 * The asking agent's face.
 *
 * The visual is RESOLVED here rather than read off the prompt: the wire carries
 * ids and a directory, precisely so a rename cannot leave a stale name on a live
 * card. A surface holding the roster passes the agent and gets its chosen colour
 * and emoji; one that does not gets the deterministic pair the whole cockpit
 * already derives from a path, so the same session looks the same everywhere.
 */
export function AskCardFace({ cwd, agent, size = 'sm', className }: AskCardFaceProps) {
  const visual = useAgentVisual(agent ?? null, cwd);
  return (
    <AgentAvatar
      color={visual.color}
      emoji={visual.emoji}
      size={size}
      badge={null}
      className={className}
    />
  );
}

/** The one sentence: who wants what. */
export function AskCardHeadline({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p data-slot="ask-headline" className={cn('text-foreground font-medium', className)}>
      {children}
    </p>
  );
}

/** Whatever the prompt itself said — a description, a path, the arguments. */
export function AskCardDetail({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="ask-detail"
      className={cn('text-muted-foreground text-2xs space-y-0.5', className)}
    >
      {children}
    </div>
  );
}

/** What {@link AskCardCountdown} takes. */
export interface AskCardCountdownProps {
  /** Seconds until this prompt auto-denies, or `null` when it has no deadline. */
  secondsLeft: number | null;
  /** The full budget in ms, for the bar's own duration. */
  timeoutMs?: number;
  /** How much of the budget was already spent when this card mounted. */
  elapsedMs?: number;
  /** Plain-words time left, for the accessible reading. */
  label: string;
}

/**
 * The draining bar and the words beside it.
 *
 * **The bar is decoration and says so** (`aria-hidden`): a progress element that
 * announced itself every second would be the siren the design system forbids.
 * The accessible countdown is the text, which changes rarely enough to be worth
 * hearing.
 */
export function AskCardCountdown({
  secondsLeft,
  timeoutMs,
  elapsedMs = 0,
  label,
}: AskCardCountdownProps) {
  const urgency = askUrgency(secondsLeft);
  return (
    <div data-slot="ask-countdown" className="flex items-center gap-2">
      {timeoutMs !== undefined && (
        <div aria-hidden className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
          <div
            className={cn(
              'h-full rounded-full transition-colors duration-500',
              urgency === 'neutral' && 'bg-muted-foreground/30',
              urgency === 'warning' && 'bg-status-warning',
              (urgency === 'urgent' || urgency === 'expired') && 'bg-status-error',
              'motion-safe:animate-drain'
            )}
            style={{
              animationDuration: `${timeoutMs}ms`,
              // Negative delay = seek. The animation runs over the whole budget,
              // so a card that mounts partway through starts partway through —
              // otherwise every reload draws a full bar over an ask that is
              // nearly out of time (DOR-810).
              animationDelay: `-${elapsedMs}ms`,
              animationTimingFunction: 'linear',
              animationFillMode: 'forwards',
            }}
          />
        </div>
      )}
      <span
        className={cn(
          'text-2xs shrink-0 tabular-nums',
          urgency === 'neutral' && 'text-muted-foreground',
          urgency === 'warning' && 'text-status-warning',
          (urgency === 'urgent' || urgency === 'expired') && 'text-status-error'
        )}
      >
        {label}
      </span>
    </div>
  );
}

/** The answers. Removed in the same commit a receipt appears. */
export function AskCardActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="ask-actions" className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
    </div>
  );
}

/** How an Ask ended, in the words the card says it. */
export type AskCardReceiptTone = 'allowed' | 'denied' | 'neutral';

/**
 * The line that replaces the actions.
 *
 * `role="status"` rather than a plain line: the buttons the reader was on have
 * just gone, so the answer has to say itself.
 */
export function AskCardReceipt({
  tone,
  children,
  className,
  'data-slot': dataSlot = 'ask-receipt',
}: {
  tone: AskCardReceiptTone;
  children: ReactNode;
  className?: string;
  /**
   * The slot name a surface resolves this line by. Defaults to `ask-receipt`;
   * the capability-approval card keeps its own shipped name, which two browser
   * suites already resolve by.
   */
  'data-slot'?: string;
}) {
  return (
    <p
      data-slot={dataSlot}
      data-tone={tone}
      role="status"
      className={cn('text-muted-foreground flex items-center gap-1.5 text-xs', className)}
    >
      {tone === 'allowed' && <Check className="text-status-success size-3.5" aria-hidden />}
      {tone === 'denied' && <X className="text-muted-foreground size-3.5" aria-hidden />}
      {children}
    </p>
  );
}

/**
 * The Ask card's parts, as one namespace.
 *
 * `Face` resolves its own visual from the directory the prompt carries, so no
 * part of this family ever takes a denormalized agent name.
 */
export const AskCard = {
  Root: AskCardRoot,
  Face: AskCardFace,
  Headline: AskCardHeadline,
  Detail: AskCardDetail,
  Countdown: AskCardCountdown,
  Actions: AskCardActions,
  Receipt: AskCardReceipt,
};
