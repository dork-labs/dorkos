import { Unplug } from 'lucide-react';
import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Skeleton,
} from '@/layers/shared/ui';
import { useConnectorAccounts, useDisconnectConnectorAccount } from '@/layers/entities/connectors';
import { accountDisplayName, FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/** Badge styling per account lifecycle status — trouble reads as trouble. */
const STATUS_BADGE_VARIANT: Record<
  PublicConnectedAccount['status'],
  'secondary' | 'outline' | 'destructive'
> = {
  active: 'secondary',
  pending: 'outline',
  expired: 'destructive',
  revoked: 'destructive',
};

/**
 * The connected accounts list: one row per account — service icon, "Gmail
 * (work)" naming, lifecycle status, the account's own server-composed custody
 * sentence, and disconnect with confirm. Two accounts of one service are two
 * visibly distinct rows (multi-account made visible).
 */
export function AccountsList() {
  const { data, isLoading, isError, error } = useConnectorAccounts();

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        Could not load connected accounts: {error.message}
      </p>
    );
  }

  const accounts = data?.accounts ?? [];
  const warnings = data?.warnings ?? [];

  return (
    <div className="space-y-3">
      {accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing connected yet. Pick a service above and connect your first account.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}
      {warnings.map((warning) => (
        <p key={warning.provider} className="text-muted-foreground text-xs">
          Some accounts may be missing: {warning.message}
        </p>
      ))}
    </div>
  );
}

/**
 * One connected account row. Also renderable standalone (Dev Playground) —
 * pass `onDisconnect` to override the live mutation.
 *
 * @param props - The account to draw and an optional disconnect override.
 * @param props.account - The public account, custody sentence included.
 * @param props.onDisconnect - Optional handler; defaults to the live mutation.
 */
export function AccountRow({
  account,
  onDisconnect,
}: {
  account: PublicConnectedAccount;
  onDisconnect?: (accountId: string) => void;
}) {
  const disconnect = useDisconnectConnectorAccount();
  const Icon = SERVICE_ICONS[account.toolkit.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
  const name = accountDisplayName(displayService(account.toolkit), account.label);
  const handleDisconnect = () =>
    onDisconnect ? onDisconnect(account.id) : disconnect.mutate({ accountId: account.id });

  return (
    <li
      data-testid={`account-row-${account.id}`}
      className="bg-card flex items-start gap-3 rounded-lg border p-3"
    >
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <Badge size="xs" variant={STATUS_BADGE_VARIANT[account.status]}>
            {account.status}
          </Badge>
        </div>
        {/* The per-account custody sentence, server-composed — every rendered
            account row carries its own truthful disclosure line. */}
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{account.disclosure}</p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive shrink-0 gap-1.5 text-xs"
            disabled={disconnect.isPending}
          >
            <Unplug className="size-3.5" aria-hidden />
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your agents lose access to this account, and sessions it was attached to stop seeing
              its tools. You can connect it again anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/**
 * A service's display name when only its slug is at hand (account rows carry
 * the toolkit slug, not the toolkit object).
 */
function displayService(toolkit: string): string {
  if (!toolkit) return 'Account';
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}
