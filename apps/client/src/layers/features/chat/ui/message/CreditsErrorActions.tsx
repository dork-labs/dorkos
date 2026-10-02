import { RotateCcw } from 'lucide-react';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { Button } from '@/layers/shared/ui';
import { useAppStore, useKeepCreditsOutOfProject } from '@/layers/shared/model';

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
  /** Why credits refused the turn (`folder-sign-in`, `off`, …), when the server said. */
  reason?: string;
}

/** The refusal of a folder whose own settings name a sign-in, which credits can never run. */
const FOLDER_SIGN_IN_REASON = 'folder-sign-in';

/**
 * The ways on from a turn refused because DorkOS credits could not pay for it
 * (ADR 261001-000811): try again, send it on this computer's own sign-in, or
 * keep credits out of this project for good. Nothing was sent and nothing was
 * billed, so every one is safe.
 *
 * "Use … sign-in" is a choice the person makes for THIS send: it rides the
 * retried message as a one-shot account, which the server honours only while
 * the session has not launched (a refused credits turn never did).
 *
 * "Don't use credits in this project" is the way on for a folder with a
 * sign-in of its own, which credits can never run, so it is offered for that
 * refusal only (a retry cannot help there, and nothing else needs a rule): it saves a project rule
 * without credits (Settings → Runtimes shows and undoes it), then retries on
 * whatever the server says the project runs on now.
 */
export function CreditsErrorActions({
  onRetry,
  sessionId,
  runtimeLabel,
  reason,
}: CreditsErrorActionsProps) {
  const setRetryAccount = useAppStore((s) => s.setRetryAccount);
  const keepOut = useKeepCreditsOutOfProject();
  if (!onRetry) return null;
  const useOwnSignIn = () => {
    if (sessionId) setRetryAccount({ id: IMPLICIT_ACCOUNT_ID, sessionId });
    onRetry();
  };
  const keepCreditsOut = () => {
    if (!sessionId) return;
    keepOut.mutate(sessionId, {
      onSuccess: ({ launch }) => {
        if (launch?.ok) setRetryAccount({ id: launch.accountId, sessionId });
        onRetry();
      },
    });
  };
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="credits-error-actions">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RotateCcw className="size-3" />
          Retry
        </Button>
        {sessionId && (
          <Button size="sm" variant="outline" onClick={useOwnSignIn}>
            Use {runtimeLabel ? `your ${runtimeLabel}` : 'your own'} sign-in
          </Button>
        )}
        {sessionId && reason === FOLDER_SIGN_IN_REASON && (
          <Button size="sm" variant="outline" onClick={keepCreditsOut} disabled={keepOut.isPending}>
            Don’t use credits in this project
          </Button>
        )}
      </div>
      {keepOut.error && (
        <p className="text-muted-foreground text-xs" role="status">
          {keepOut.error.message}
        </p>
      )}
    </div>
  );
}
