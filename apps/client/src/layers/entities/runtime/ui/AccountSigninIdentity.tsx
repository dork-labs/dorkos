import { useDelegateRuntimeLogin } from '../model/use-credential-connect';
import { useSigninPolicy } from '../model/use-signin-policy';
import { OwnerSigninAction } from './OwnerSigninAction';
import { Button } from '@/layers/shared/ui';

/** Account row identity from the owner-only endpoint; no device-based authority check. */
export function AccountSigninIdentity({ accountId, name }: { accountId: string; name: string }) {
  const { data, isPending } = useSigninPolicy();
  const login = useDelegateRuntimeLogin('claude-code', { accountId });
  const identity = data?.accounts.find((account) => account.accountId === accountId)?.identity;
  if (isPending) return <p className="text-muted-foreground text-xs">Checking…</p>;
  if (!identity || identity.state === 'never-use') return null;
  if (identity.state === 'confirmed')
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          {name} is signed in as {identity.email}.
        </p>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Sign in to ${name}`}
          disabled={login.isPending}
          onClick={login.login}
        >
          Sign in
        </Button>
      </div>
    );
  const blocked = identity.state === 'blocked';
  return (
    <div className="space-y-2 text-xs">
      {blocked ? (
        <>
          <p>{name} is signed in to an account DorkOS doesn’t use.</p>
          <p>Sign in with a different one.</p>
        </>
      ) : identity.state === 'changed' ? (
        <>
          <p>
            {name} is now signed in as {identity.email}, not {identity.previousEmail} as before.
          </p>
          <p>Its agents stay paused until you choose.</p>
        </>
      ) : (
        <p>This sign-in needs your review. Its agents stay paused.</p>
      )}
      <p className="text-muted-foreground">Paused · new login not confirmed</p>
      <div className="flex flex-wrap gap-2">
        {!blocked && identity.state !== 'unreadable' && (
          <OwnerSigninAction
            label="Use this account"
            title={`Confirm it’s you to use ${identity.email} for ${name}`}
            change={{ action: 'accept', accountId }}
          />
        )}
        <Button variant="outline" size="sm" disabled={login.isPending} onClick={login.login}>
          Sign in again
        </Button>
      </div>
    </div>
  );
}
