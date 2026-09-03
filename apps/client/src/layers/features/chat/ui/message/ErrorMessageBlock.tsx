import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react';
import type { ErrorCategory } from '@dorkos/shared/types';
import { Button, LinkifiedText, containsUrl } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { AuthErrorActions } from './AuthErrorActions';

const collapseTransition = { duration: 0.25, ease: [0.4, 0, 0.2, 1] } as const;

/** Runtime name in the auth heading ("Sign in to X again") when unresolved. */
const AUTH_HEADING_FALLBACK_NAME = 'your agent';
/** Runtime name in the auth subtext ("Your X login...") when unresolved. */
const AUTH_SUBTEXT_FALLBACK_NAME = 'agent';

const ERROR_COPY: Record<ErrorCategory, { heading: string; subtext: string; retryable: boolean }> =
  {
    max_turns: {
      heading: 'Turn limit reached',
      subtext: 'The agent ran for its maximum number of turns.',
      retryable: false,
    },
    execution_error: {
      heading: 'Agent stopped unexpectedly',
      subtext: 'An error occurred during execution.',
      retryable: true,
    },
    budget_exceeded: {
      heading: 'Cost limit reached',
      subtext: 'This session exceeded its budget.',
      retryable: false,
    },
    output_format_error: {
      heading: 'Output format error',
      subtext: "The agent couldn't produce the required output format.",
      retryable: false,
    },
    auth_error: {
      // Heading and subtext are finalized at render with the runtime name
      // (see authHeading / authSubtext); these are neutral placeholders.
      heading: 'Sign in again',
      subtext: 'Your login stopped working. Sign in again to pick up where you left off.',
      retryable: true,
    },
  };

/**
 * Categories whose own copy explains the failure on its own, so the runtime's
 * message does not take the subtext slot.
 *
 * `execution_error` is deliberately absent: "An error occurred during
 * execution." only restates its own heading, so on that category the runtime's
 * own words take the subtext slot and the generic sentence is the fallback for
 * when there are none. Before this, an inline `execution_error` part silently
 * replaced a specific server-authored message — "That model isn't available.
 * Pick another one from the model menu." — with that placeholder, because only
 * `TurnFailedNotice` passed `subtext` explicitly.
 */
const SELF_EXPLANATORY_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'max_turns',
  'budget_exceeded',
  'output_format_error',
  'auth_error',
]);

/**
 * Build the runtime-aware auth heading. Neutral across causes (expired,
 * revoked, invalid key), falling back to a generic name when unresolved.
 */
function authHeading(runtimeLabel: string | undefined): string {
  return `Sign in to ${runtimeLabel ?? AUTH_HEADING_FALLBACK_NAME} again`;
}

/** Build the runtime-aware auth subtext. Neutral across causes. */
function authSubtext(runtimeLabel: string | undefined): string {
  const name = runtimeLabel ?? AUTH_SUBTEXT_FALLBACK_NAME;
  return `Your ${name} login stopped working. Sign in again to pick up where you left off.`;
}

interface ErrorMessageBlockProps {
  /**
   * What the runtime actually said. Never dropped: it takes the subtext slot
   * unless the category's own copy explains the failure better, in which case
   * it is shown on its own line beneath it.
   */
  message: string;
  category?: ErrorCategory;
  details?: string;
  onRetry?: () => void;
  /** Override the category-derived heading. */
  heading?: string;
  /**
   * Override the subtext line. A caller that already puts `message` here (e.g.
   * `TurnFailedNotice`) does not get it repeated underneath.
   */
  subtext?: string;
  /**
   * Display name of the runtime that failed (e.g. "Claude", "Codex").
   * Personalizes the `auth_error` copy; falls back to a neutral name when absent.
   */
  runtimeLabel?: string;
  /**
   * Session this error belongs to. For an `auth_error` it is what lets the card
   * sign in on the spot: it resolves which runtime failed and which account that
   * session is bound to. Without it the card falls back to the settings
   * deep-link, because there is no honest way to know what to sign into.
   */
  sessionId?: string;
  /**
   * Called once when a sign-in started from this card completes, so the
   * conversation can re-send the turn that failed (DOR-1650). Returns whether
   * it did — the card only claims to be sending when something is.
   */
  onSigninComplete?: () => boolean;
}

/**
 * Inline error block rendered in the assistant message stream — the single
 * renderer for every chat-surfaced runtime error (inline error parts, the
 * panel-level `TurnFailedNotice`, and transport errors from `ChatPanel`).
 *
 * Shows a category-specific heading, the failure text, an optional retry
 * button, and collapsible raw details. For `auth_error` with a session in
 * context it signs the runtime back in on the spot (DOR-1651); without one, or
 * for a runtime that picks a provider rather than logging in, it deep-links to
 * Settings → Runtimes instead.
 *
 * **Nothing the runtime said is thrown away, and every URL in it is a real
 * link.** Both were broken: friendly `auth_error` copy replaced the raw
 * message outright (so an OpenRouter "add credits at <url>" arrived with the
 * actionable half missing), the generic `execution_error` sentence shadowed
 * server-authored copy on the inline path, and all three text slots rendered
 * as inert text nodes — a URL in an error was something to retype by hand.
 * Text renders through {@link LinkifiedText}: literal text with bare `http(s)`
 * URLs as real anchors, deliberately NOT as markdown (see that module for why
 * untrusted machine output is linkified rather than parsed).
 */
export function ErrorMessageBlock({
  message,
  category,
  details,
  onRetry,
  heading: headingOverride,
  subtext: subtextOverride,
  runtimeLabel,
  sessionId,
  onSigninComplete,
}: ErrorMessageBlockProps) {
  const [showDetails, setShowDetails] = useState(false);
  const isAuthError = category === 'auth_error';
  // Defensive lookup: an unrecognized category falls back to execution-error
  // copy (forward-compat) rather than crashing on an undefined entry.
  const copy = category ? (ERROR_COPY[category] ?? ERROR_COPY.execution_error) : null;
  const derivedHeading = isAuthError ? authHeading(runtimeLabel) : copy?.heading;
  const derivedSubtext = isAuthError ? authSubtext(runtimeLabel) : copy?.subtext;
  const heading = headingOverride ?? derivedHeading ?? 'Error';
  const runtimeText = message.trim();
  // Category copy that explains the failure keeps the subtext slot; anywhere
  // else the runtime's own words win, with the category sentence as fallback.
  const explainsItself = category !== undefined && SELF_EXPLANATORY_CATEGORIES.has(category);
  const subtext =
    subtextOverride ??
    (explainsItself ? derivedSubtext : runtimeText || derivedSubtext) ??
    runtimeText;
  // `subtext` is trimmed before comparing because two of the three callers
  // (`TurnFailedNotice`, `ChatPanel`) pass the SAME string as both `message`
  // and `subtext`. Comparing a trimmed message against an untrimmed subtext
  // made a provider message with a trailing newline — exactly the shape the
  // `whitespace-pre-wrap` below exists for — print twice.
  const subtextText = subtext.trim();
  // What the runtime actually said, when it is worth a line of its own.
  //
  // **A link is the test, and it is not arbitrary.** For a category whose own
  // sentence already explains the failure, the runtime message is usually a
  // paraphrase of that sentence rather than news — and on claude-code, the
  // DEFAULT runtime, it is not provider text at all: the server already
  // substituted DorkOS's own copy ("Your sign-in stopped working. Sign in again
  // to keep going." — `messaging/message-sender.ts`) and parked the raw string
  // in `details`. Printing that under the friendly copy produced three lines
  // saying one thing, which reads as three separate failures (DOR-1661 review).
  // A link is the one thing a generic sentence structurally cannot carry, and
  // losing it is what the operator actually reported. Everything else stays
  // reachable under Details rather than being dropped.
  const carriesLink = useMemo(() => containsUrl(runtimeText), [runtimeText]);
  const isRedundant = !runtimeText || runtimeText === subtextText || runtimeText === heading;
  const runtimeMessage = !isRedundant && (!explainsItself || carriesLink) ? runtimeText : null;
  // Never lost: a message that earns no prose line joins the raw details
  // instead of falling off the screen.
  const detailsText =
    isRedundant || runtimeMessage !== null || details?.includes(runtimeText)
      ? details
      : [details, runtimeText].filter(Boolean).join('\n');
  // When a category is provided, use its retryable flag. When no category,
  // trust the caller — if they passed onRetry, they want the button.
  const retryable = copy?.retryable ?? !!onRetry;

  return (
    <div
      data-testid="error-message-block"
      className={cn(
        'my-2 rounded-lg border px-4 py-3',
        'border-destructive/30 bg-destructive/5 text-foreground'
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{heading}</p>
          {/* `whitespace-pre-wrap` because this is machine output, not prose:
              a multi-line provider message keeps its line breaks instead of
              collapsing into one run-on sentence. `wrap-anywhere` because the
              same machine output routinely carries a file path or a URL, and
              one unbroken token has no space to wrap at — it would run out of
              the message and off a phone screen (DOR-1747). Prose is unaffected:
              the rule only applies where a word cannot otherwise fit. */}
          <p className="text-muted-foreground mt-0.5 text-sm wrap-anywhere whitespace-pre-wrap">
            <LinkifiedText text={subtext} />
          </p>
          {runtimeMessage && (
            <p className="text-muted-foreground mt-1 text-sm wrap-anywhere whitespace-pre-wrap">
              <LinkifiedText text={runtimeMessage} />
            </p>
          )}
          {detailsText && (
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs"
              aria-expanded={showDetails}
            >
              <motion.div
                animate={{ rotate: showDetails ? 0 : -90 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                <ChevronDown className="size-3" />
              </motion.div>
              Details
            </button>
          )}
          <AnimatePresence initial={false}>
            {showDetails && detailsText && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={collapseTransition}
                className="overflow-hidden"
              >
                <pre className="bg-muted/50 mt-1 max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
                  <LinkifiedText text={detailsText} />
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
          {isAuthError && (
            <AuthErrorActions
              sessionId={sessionId}
              onRetry={onRetry}
              onSigninComplete={onSigninComplete}
            />
          )}
        </div>
        {!isAuthError && retryable && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 gap-1.5">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
