import { CircleAlert, Trash2 } from 'lucide-react';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { ServerConfig } from '@dorkos/shared/types';
import { accountWindow, cn, shortenHomePath } from '@/layers/shared/lib';
import { Button, buttonVariants, UsageBar } from '@/layers/shared/ui';
import { AccountSignin, AccountSigninIdentity, useSigninPolicy } from '@/layers/entities/runtime';
import { AccountColorControl } from './AccountColorControl';
import { AccountRowRules, type AccountRule } from './AccountRowRules';

type Account = NonNullable<ServerConfig['claudeCode']>['accounts'][number];

/**
 * One account: what it is called, where it lives, and whether DorkOS can read
 * it. A registered account can be removed; this computer's own sign-in (Main,
 * passed without `onRemove`) cannot.
 */
export function ClaudeAccountRow({
  name,
  signInState,
  account,
  isActive,
  onRemove,
  onChooseColor,
  rule,
  disabled,
  identity,
}: {
  name: string;
  signInState?: AccountUsage['signInState'];
  account: Pick<Account, 'path' | 'color' | 'colorIsDefault' | 'isAccountRoot'>;
  isActive: boolean;
  /** Removes the account from the registry; absent for an account that is not in it. */
  onRemove?: () => void;
  onChooseColor: (color: string | null) => void;
  /**
   * The account's rules (spec `flow-multiproject` §8.5, Re-seat P0): its id,
   * the projects it is kept to, and its automatic moves. Absent for a row
   * nothing can name.
   */
  rule?: AccountRule | null;
  disabled: boolean;
  /** The account's identity and usage, present only while the identity gate is open. */
  identity: { usage: AccountUsage | undefined } | null;
}) {
  const policy = useSigninPolicy();
  const hasIdentity = policy.data?.accounts.some((row) => row.accountId === rule?.accountId);
  return (
    <div className="flex items-start gap-3" data-testid="claude-account-row">
      {identity && (
        <span className="mt-1 flex">
          <AccountColorControl
            name={name}
            color={account.color}
            colorIsDefault={account.colorIsDefault}
            onChoose={onChooseColor}
            disabled={disabled}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {name}
          {isActive && <span className="text-muted-foreground ml-2 text-xs">in use</span>}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs" title={account.path}>
          {shortenHomePath(account.path)}
        </p>
        {rule && hasIdentity ? (
          <AccountSigninIdentity accountId={rule.accountId} name={name} />
        ) : (
          <AccountSignin accountRoot={account.path} name={name} state={signInState} />
        )}
        {rule && <AccountRowRules name={name} rule={rule} disabled={disabled} />}
        {!account.isAccountRoot && (
          <p
            className="text-muted-foreground mt-1 flex items-start gap-1.5 text-xs"
            data-testid="claude-account-not-ready"
          >
            <CircleAlert className="text-destructive mt-px size-3 shrink-0" aria-hidden />
            <span>Not a Claude Code account yet. No chats show from it.</span>
          </p>
        )}
      </div>
      {identity && (
        <div className="w-36 shrink-0 space-y-1 pt-0.5">
          <UsageBar window={accountWindow(identity.usage, 'five_hour')} label="5h" compact />
          <UsageBar window={accountWindow(identity.usage, 'seven_day')} label="wk" compact />
        </div>
      )}
      {onRemove ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${name}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : (
        // Holds the remove button's place so every row's bars line up. It wears
        // the button's own classes, so its width follows the button's. Not a
        // button and not focusable: nothing to click, nothing to announce.
        <span
          aria-hidden="true"
          data-testid="claude-account-remove-spacer"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'invisible')}
        >
          <Trash2 className="size-3.5" />
        </span>
      )}
    </div>
  );
}
