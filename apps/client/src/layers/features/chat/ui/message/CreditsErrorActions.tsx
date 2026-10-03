import { RotateCcw } from 'lucide-react';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { Button } from '@/layers/shared/ui';
import {
  useAppStore,
  useKeepCreditsOutOfProject,
  useSetCreditsDefault,
} from '@/layers/shared/model';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useSessionRuntime, useStartNewSession } from '@/layers/entities/session';

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
 * "Use … sign-in" is a choice the person makes for THIS send on a runtime
 * with accounts of its own (Claude Code): it rides the retried message as a
 * one-shot account, which the server honours only while the session has not
 * launched (a refused credits turn never did). A runtime with no account
 * list (Codex, OpenCode) has nothing per send to pick, so there it records
 * the person's "no" for that runtime, exactly as turning credits off does,
 * and then retries.
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
  const setCreditsDefault = useSetCreditsDefault();
  const startNewSession = useStartNewSession();
  // A session with no row yet runs on the server's default runtime.
  const listedRuntime = useSessionRuntime(sessionId);
  const capabilities = useCapabilitiesForRuntime(listedRuntime ?? null);
  if (!onRetry) return null;
  const way = ownSignInWay(capabilities);
  const label = runtimeLabel ? `your ${runtimeLabel}` : 'your own';
  const useOwnSignIn = () => {
    if (capabilities === undefined) return;
    if (way === 'pick-for-send') {
      if (sessionId) setRetryAccount({ id: IMPLICIT_ACCOUNT_ID, sessionId });
      onRetry();
      return;
    }
    setCreditsDefault.mutate(
      { runtime: capabilities.type, useCredits: false },
      {
        // A conversation that started on credits lives where credits keep it
        // and cannot move; a new one on the person's own sign-in can start.
        onSuccess: () =>
          way === 'new-conversation'
            ? startNewSession(undefined, { runtime: capabilities.type })
            : onRetry(),
      }
    );
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
          <Button
            size="sm"
            variant="outline"
            onClick={useOwnSignIn}
            // Which way back is right depends on the runtime, so it waits for
            // the runtime's capabilities rather than guess.
            disabled={capabilities === undefined || setCreditsDefault.isPending}
          >
            {way === 'new-conversation'
              ? `Start a new conversation on ${label} sign-in`
              : `Use ${label} sign-in`}
          </Button>
        )}
        {sessionId && reason === FOLDER_SIGN_IN_REASON && (
          <Button size="sm" variant="outline" onClick={keepCreditsOut} disabled={keepOut.isPending}>
            Don’t use credits in this project
          </Button>
        )}
      </div>
      {sessionId && way === 'whole-runtime' && (
        <p className="text-muted-foreground text-xs" data-testid="credits-own-sign-in-reach">
          This moves all {runtimeLabel ?? 'its'} conversations to {label} sign-in, not just this
          one.
        </p>
      )}
      {keepOut.error && (
        <p className="text-muted-foreground text-xs" role="status">
          {keepOut.error.message}
        </p>
      )}
      {setCreditsDefault.isError && (
        <p className="text-muted-foreground text-xs" role="status">
          Couldn’t switch to your own sign-in. Try again in a moment.
        </p>
      )}
    </div>
  );
}

/** How the way back to the person's own sign-in works for a runtime. */
type OwnSignInWay = 'pick-for-send' | 'new-conversation' | 'whole-runtime';

/**
 * How a runtime goes back to the person's own sign-in after a refused credits
 * turn: a one-shot account pick for the retried send (a runtime with accounts,
 * Claude Code); a recorded "no" and a fresh conversation (a conversation-scoped
 * runtime without accounts, Codex, whose conversation on credits cannot move);
 * or a recorded "no" that moves the whole runtime, then a retry (OpenCode).
 *
 * @param capabilities - The session's runtime capabilities.
 */
function ownSignInWay(
  capabilities: { supportsAccounts: boolean; credits?: { scope: string } } | undefined
): OwnSignInWay {
  if (capabilities === undefined || capabilities.supportsAccounts) return 'pick-for-send';
  return capabilities.credits?.scope === 'conversation' ? 'new-conversation' : 'whole-runtime';
}
