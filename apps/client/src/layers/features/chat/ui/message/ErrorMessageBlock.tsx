import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ChevronDown, LogIn, RotateCcw } from 'lucide-react';
import type { ErrorCategory } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useSettingsDeepLink } from '@/layers/shared/model';

const collapseTransition = { duration: 0.25, ease: [0.4, 0, 0.2, 1] } as const;

/** Settings tab that hosts runtime sign-in — where "Fix sign-in" deep-links. */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

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

/**
 * Actions for an auth error: a primary "Fix sign-in" that deep-links to
 * Settings → Runtimes, and an optional secondary Retry. Extracted so the
 * router-backed deep-link hook is only invoked for auth errors — non-auth
 * error blocks stay router-independent.
 */
function AuthErrorActions({ onRetry }: { onRetry?: () => void }) {
  const { open: openSettings } = useSettingsDeepLink();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)} className="gap-1.5">
        <LogIn className="size-3" />
        Fix sign-in
      </Button>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
          <RotateCcw className="size-3" />
          Retry
        </Button>
      )}
    </div>
  );
}

interface ErrorMessageBlockProps {
  message: string;
  category?: ErrorCategory;
  details?: string;
  onRetry?: () => void;
  /** Override the category-derived heading. */
  heading?: string;
  /** Override the category-derived subtext. */
  subtext?: string;
  /**
   * Display name of the runtime that failed (e.g. "Claude", "Codex").
   * Personalizes the `auth_error` copy; falls back to a neutral name when absent.
   */
  runtimeLabel?: string;
}

/**
 * Inline error block rendered in the assistant message stream.
 * Shows category-specific heading/sub-text, optional retry button,
 * and collapsible raw error details. For `auth_error` it renders a primary
 * "Fix sign-in" action that deep-links to Settings → Runtimes.
 */
export function ErrorMessageBlock({
  message,
  category,
  details,
  onRetry,
  heading: headingOverride,
  subtext: subtextOverride,
  runtimeLabel,
}: ErrorMessageBlockProps) {
  const [showDetails, setShowDetails] = useState(false);
  const isAuthError = category === 'auth_error';
  // Defensive lookup: an unrecognized category falls back to execution-error
  // copy (forward-compat) rather than crashing on an undefined entry.
  const copy = category ? (ERROR_COPY[category] ?? ERROR_COPY.execution_error) : null;
  const derivedHeading = isAuthError ? authHeading(runtimeLabel) : copy?.heading;
  const derivedSubtext = isAuthError ? authSubtext(runtimeLabel) : copy?.subtext;
  const heading = headingOverride ?? derivedHeading ?? 'Error';
  const subtext = subtextOverride ?? derivedSubtext ?? message;
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
          <p className="text-muted-foreground mt-0.5 text-sm">{subtext}</p>
          {details && (
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
            {showDetails && details && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={collapseTransition}
                className="overflow-hidden"
              >
                <pre className="bg-muted/50 mt-1 max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
                  {details}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
          {isAuthError && <AuthErrorActions onRetry={onRetry} />}
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
