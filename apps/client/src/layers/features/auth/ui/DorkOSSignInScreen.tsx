import { useId, useState } from 'react';
import { Lock } from 'lucide-react';
import { Button, Checkbox, Notice } from '@/layers/shared/ui';
import { describeAuthError } from '../lib/auth-error-copy';
import { DORKOS_SIGN_IN_FAILED, useContinueWithDorkOS } from '../model/use-auth-session';

/**
 * What to say when the page was reached back from a DorkOS sign-in that did
 * not finish, or `null` when it was not. Only a refused account (the sign-in
 * turns away anyone but the owner, which Better Auth reports as
 * `unable_to_get_user_info`) is told it cannot sign in here; a cancel or a
 * passing fault is asked to try again.
 */
function cameBackFailed(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(DORKOS_SIGN_IN_FAILED)) return null;
  return params.get('error') === 'unable_to_get_user_info'
    ? 'That DorkOS account can’t sign in here.'
    : 'Sign-in didn’t finish. Try again.';
}

/**
 * Sign-in for a person's own DorkOS in the cloud, which has no passwords: one
 * button that signs in with the DorkOS account it belongs to. Rendered by the
 * {@link AuthGuard} when the server's `401` says `signInWith: 'dorkos'`.
 */
export function DorkOSSignInScreen() {
  const errorId = useId();
  const publicId = useId();
  const [publicComputer, setPublicComputer] = useState(false);
  const { run, isPending, error } = useContinueWithDorkOS();
  const [failed] = useState(cameBackFailed);
  const errorCopy = describeAuthError(error, window.location.origin);
  const message = errorCopy?.message ?? failed;

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

        <div className="mb-4 flex items-start gap-2.5">
          <Checkbox
            id={publicId}
            checked={publicComputer}
            onCheckedChange={(value) => setPublicComputer(value === true)}
            disabled={isPending}
            className="mt-0.5"
          />
          <label htmlFor={publicId} className="space-y-1 text-sm leading-snug">
            <span className="font-medium">This is a shared or public computer</span>
            <span className="text-muted-foreground block text-xs">
              Signs you out when the browser closes or sits idle.
            </span>
          </label>
        </div>

        <Button
          className="w-full"
          disabled={isPending}
          aria-describedby={message ? errorId : undefined}
          onClick={() => void run(publicComputer)}
        >
          {isPending ? 'Opening DorkOS…' : 'Continue with DorkOS'}
        </Button>
      </div>
    </div>
  );
}
