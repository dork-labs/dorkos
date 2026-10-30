import type { AccountUsage } from '@dorkos/shared/account-usage';
import { useDelegateRuntimeLogin } from '../model/use-credential-connect';
import { useSigninPolicy } from '../model/use-signin-policy';
import { accountRowState, type AccountRowState } from '../lib/account-row-state';
import { AccountSignin } from './AccountSignin';
import { OwnerSigninAction } from './OwnerSigninAction';
import { Button } from '@/layers/shared/ui';

/** Keeps a 44px hit area under a coarse pointer; the button's look is unchanged. */
const COARSE_HIT = 'pointer-coarse:min-h-11';

/**
 * An account row's one sign-in status line and its one action, picked by
 * {@link accountRowState}. The identity review comes from the owner-only
 * endpoint; a viewer who cannot read it still sees the signed-out recovery.
 */
export function AccountSigninIdentity({
  accountId,
  accountRoot,
  name,
  signInState,
}: {
  /** The account's registry id; without one there is no identity to review. */
  accountId?: string;
  accountRoot: string;
  name: string;
  signInState?: AccountUsage['signInState'];
}) {
  const { data } = useSigninPolicy();
  const identity = accountId
    ? data?.accounts.find((account) => account.accountId === accountId)?.identity
    : undefined;
  const state = accountRowState({ identity, signInState });
  return (
    <AccountRowStatus state={state} accountId={accountId} accountRoot={accountRoot} name={name} />
  );
}

function AccountRowStatus({
  state,
  accountId,
  accountRoot,
  name,
}: {
  state: AccountRowState;
  accountId?: string;
  accountRoot: string;
  name: string;
}) {
  switch (state.kind) {
    case 'healthy':
      return null;
    case 'blocked':
      return (
        <p className="text-status-warning-fg mt-1 text-xs" role="status">
          Not used · on your Never use list
        </p>
      );
    case 'signed-out':
      return <AccountSignin accountRoot={accountRoot} name={name} state="signed-out" />;
    case 'changed':
      return (
        <div className="mt-1 space-y-2 text-xs">
          <p className="text-status-warning-fg" role="status">
            Now signed in as {state.email}, not {state.previousEmail}.
          </p>
          <p className="text-muted-foreground">
            DorkOS won’t pick it on its own until you keep it.
          </p>
          {accountId && (
            <ConfirmSignin
              accountId={accountId}
              name={name}
              email={state.email}
              label="Keep this sign-in"
            />
          )}
        </div>
      );
    case 'unconfirmed':
      return (
        <div className="mt-1 space-y-2 text-xs">
          <p className="text-status-warning-fg" role="status">
            New sign-in{state.email ? ` ${state.email}` : ''}. Not confirmed yet.
          </p>
          <p className="text-muted-foreground">DorkOS won’t pick it on its own until you do.</p>
          {accountId ? (
            <ConfirmSignin
              accountId={accountId}
              name={name}
              email={state.email}
              label="Use this account"
            />
          ) : (
            <SignInAgain accountRoot={accountRoot} name={name} />
          )}
        </div>
      );
  }
}

function ConfirmSignin({
  accountId,
  name,
  email,
  label,
}: {
  accountId: string;
  name: string;
  email?: string;
  label: string;
}) {
  return (
    <OwnerSigninAction
      label={label}
      title={email ? `Use ${email} for ${name}?` : `Use this sign-in for ${name}?`}
      description="DorkOS can then pick this account on its own."
      change={{ action: 'accept', accountId }}
    />
  );
}

function SignInAgain({
  accountId,
  accountRoot,
  name,
}: {
  accountId?: string;
  accountRoot: string;
  name: string;
}) {
  const login = useDelegateRuntimeLogin('claude-code', accountId ? { accountId } : { accountRoot });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className={COARSE_HIT}
        disabled={login.isPending}
        onClick={login.login}
        aria-label={`Sign in to ${name}`}
      >
        {login.isPending ? 'Signing in…' : 'Sign in again'}
      </Button>
      {login.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t sign in to {name}. Try again.
        </p>
      )}
    </div>
  );
}
