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
          Paused · on your Never use list
        </p>
      );
    case 'signed-out':
      return <AccountSignin accountRoot={accountRoot} name={name} state="signed-out" />;
    case 'changed':
      return (
        <div className="mt-1 space-y-2 text-xs">
          <p className="text-status-warning-fg" role="status">
            {name} is now signed in as {state.email}, not {state.previousEmail}. Its agents stay
            paused.
          </p>
          {accountId && <UseThisAccount accountId={accountId} name={name} email={state.email} />}
        </div>
      );
    case 'paused':
      return (
        <div className="mt-1 space-y-2 text-xs">
          <p className="text-status-warning-fg" role="status">
            {state.reason === 'unreadable'
              ? 'DorkOS couldn’t read this sign-in. Its agents stay paused.'
              : 'Paused · new login not confirmed'}
          </p>
          {state.reason === 'unconfirmed' && accountId ? (
            <UseThisAccount accountId={accountId} name={name} email={state.email} />
          ) : (
            <SignInAgain accountId={accountId} accountRoot={accountRoot} name={name} />
          )}
        </div>
      );
  }
}

function UseThisAccount({
  accountId,
  name,
  email,
}: {
  accountId: string;
  name: string;
  email?: string;
}) {
  return (
    <OwnerSigninAction
      label="Use this account"
      title={
        email ? `Confirm it’s you to use ${email} for ${name}` : `Confirm it’s you for ${name}`
      }
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
