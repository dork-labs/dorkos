import { useMiniAppAccess, useRevokeMiniAppAccess } from '@/layers/entities/connectors';
import { formatRelativeTime } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { PanelSection } from './panel-parts';

/**
 * "Mini apps that can read this" on an account's panel (DOR-3547): each mini
 * app with a yes for this account, and Revoke. Renders nothing when none has
 * one. Giving a yes never happens here: that is its own page outside the app.
 */
export function MiniAppReaders({ connectionId }: { connectionId: string }) {
  const access = useMiniAppAccess();
  const revoke = useRevokeMiniAppAccess();
  const readers = (access.data?.allowed ?? []).filter((item) => item.connectionId === connectionId);
  if (readers.length === 0) return null;

  return (
    <PanelSection
      title="Mini apps that can read this"
      description="They can only read. Revoke stops their next read."
      testId="mini-app-readers"
    >
      <ul className="divide-border divide-y rounded-lg border">
        {readers.map((item) => (
          <li key={item.approvalId} className="flex min-h-12 items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{item.extensionName}</span>
              <span className="text-muted-foreground block text-xs">
                Allowed {formatRelativeTime(item.approvedAt)}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={revoke.isPending && revoke.variables === item.approvalId}
              onClick={() => revoke.mutate(item.approvalId)}
              aria-label={`Revoke ${item.extensionName}`}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {revoke.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t revoke it. Try again.
        </p>
      )}
    </PanelSection>
  );
}
