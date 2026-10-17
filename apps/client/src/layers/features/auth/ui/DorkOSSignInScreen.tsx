import { useId, useState } from 'react';
import { Lock } from 'lucide-react';
import { Button, Notice } from '@/layers/shared/ui';
import { describeAuthError } from '../lib/auth-error-copy';
import { DORKOS_SIGN_IN_FAILED, useContinueWithDorkOS } from '../model/use-auth-session';

/** Whether the page was reached back from a DorkOS sign-in that was refused. */
function cameBackRefused(): boolean {
  return new URLSearchParams(window.location.search).has(DORKOS_SIGN_IN_FAILED);
}

/**
 * Sign-in for a person's own DorkOS in the cloud, which has no passwords: one
 * button that signs in with the DorkOS account it belongs to. Rendered by the
 * {@link AuthGuard} when the server's `401` says `signInWith: 'dorkos'`.
 */
export function DorkOSSignInScreen() {
  const errorId = useId();
  const { run, isPending, error } = useContinueWithDorkOS();
  const [refused] = useState(cameBackRefused);
  const errorCopy = describeAuthError(error, window.location.origin);
  const message =
    errorCopy?.message ?? (refused ? 'That DorkOS account can’t sign in here.' : null);

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="bg-card shadow-elevated w-full max-w-sm rounded-xl border p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-muted mb-3 flex size-11 items-center justify-center rounded-full">
            <Lock className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">Sign in to DorkOS</h1>
          <p className="text-muted-foreground mt-1 text-sm">Use your DorkOS account.</p>
        </div>

        {message && (
          <Notice id={errorId} tone="error" className="mb-4 space-y-1">
            <p>{message}</p>
            {errorCopy?.detail && (
              <p className="text-muted-foreground text-xs">{errorCopy.detail}</p>
            )}
          </Notice>
        )}

        <Button
          className="w-full"
          disabled={isPending}
          aria-describedby={message ? errorId : undefined}
          onClick={() => void run()}
        >
          {isPending ? 'Opening DorkOS…' : 'Continue with DorkOS'}
        </Button>
      </div>
    </div>
  );
}
