import { RotateCcw } from 'lucide-react';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';

/** The part code of a turn refused because DorkOS credits could not pay for it. */
export const CREDITS_UNAVAILABLE_CODE = 'credits_unavailable';

/** Props for {@link CreditsErrorActions}. */
interface CreditsErrorActionsProps {
  /** Re-sends the turn that was refused. */
  onRetry?: () => void;
  /** The session the refused turn belongs to. */
  sessionId?: string;
  /** The runtime's display name, for "Use your Claude Code sign-in". */
  runtimeLabel?: string;
}

/**
 * The two ways on from a turn refused because DorkOS credits could not be
 * reached (ADR 261001-000811): try again, or send it on this computer's own
 * sign-in instead. Nothing was sent and nothing was billed, so both are safe.
 *
 * "Use … sign-in" is a choice the person makes for THIS send: it rides the
 * retried message as a one-shot account, which the server honours only while
 * the session has not launched (a refused credits turn never did).
 */
export function CreditsErrorActions({
  onRetry,
  sessionId,
  runtimeLabel,
}: CreditsErrorActionsProps) {
  const setRetryAccount = useAppStore((s) => s.setRetryAccount);
  if (!onRetry) return null;
  const useOwnSignIn = () => {
    if (sessionId) setRetryAccount({ id: IMPLICIT_ACCOUNT_ID, sessionId });
    onRetry();
  };
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="credits-error-actions">
      <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
        <RotateCcw className="size-3" />
        Retry
      </Button>
      {sessionId && (
        <Button size="sm" variant="outline" onClick={useOwnSignIn}>
          Use {runtimeLabel ? `your ${runtimeLabel}` : 'your own'} sign-in
        </Button>
      )}
    </div>
  );
}
