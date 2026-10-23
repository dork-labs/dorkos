import { Button } from '@/layers/shared/ui';
import { useDelegateRuntimeLogin } from '../model/use-credential-connect';

/** Sign in to an explicitly named Claude account; never uses the default target. */
export function AccountSignin({
  accountRoot,
  name,
  state = 'unknown',
  showAccountName = false,
}: {
  accountRoot: string;
  name: string;
  state?: 'signed-in' | 'signed-out' | 'unknown';
  showAccountName?: boolean;
}) {
  const login = useDelegateRuntimeLogin('claude-code', { accountRoot });
  const observed = state === 'unknown' && login.isSuccess ? 'signed-in' : state;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs" role="status">
        {observed === 'signed-in'
          ? 'Signed in'
          : observed === 'signed-out'
            ? 'Signed out'
            : 'Not checked yet'}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={login.login}
        disabled={login.isPending}
        aria-label={`Sign in to ${name}`}
      >
        {login.isPending ? 'Signing in…' : showAccountName ? `Sign in to ${name}` : 'Sign in'}
      </Button>
      {login.isError && observed !== 'signed-in' && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t sign in. Try again.
        </p>
      )}
    </div>
  );
}
