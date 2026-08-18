import type { StandingPermission } from '@dorkos/shared/approval-schemas';
import { Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { cn, shortenHomePath } from '@/layers/shared/lib';
import { formatTimeLeft } from '@/layers/features/ask';
import { useRevokeStandingPermission } from '../model/use-standing-permissions';

export interface StandingPermissionListProps {
  /** The permissions that are live right now, soonest to expire first. */
  permissions: StandingPermission[];
  className?: string;
}

/**
 * Which agent a row is about, disambiguated only when it has to be.
 *
 * The label is a folder name and two agents can share one — `~/work/acme/helper`
 * and `~/work/beta/helper` both read as "helper". A list that cannot tell them
 * apart is not a list a person can act on, so a repeated label falls back to the
 * path. Rows that are already unambiguous keep the short handle, because showing
 * every path all the time would make the common case harder to read to fix a case
 * that is usually not there.
 *
 * @param permissions - The whole list, since ambiguity is a property of the list.
 * @returns A map from grant id to the name to draw.
 */
function agentNames(permissions: StandingPermission[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const permission of permissions) {
    seen.set(permission.agentLabel, (seen.get(permission.agentLabel) ?? 0) + 1);
  }
  return new Map(
    permissions.map((permission) => [
      permission.grantId,
      (seen.get(permission.agentLabel) ?? 0) > 1
        ? shortenHomePath(permission.agentPath)
        : permission.agentLabel,
    ])
  );
}

/**
 * The standing permissions that are live, and the button that ends each one.
 *
 * Rendered in both places a person can find one: the header panel and Settings
 * under Security. Same component in both, so what a permission looks like and how
 * it is ended cannot differ between the place somebody stumbles on it and the
 * place they go looking for it.
 *
 * ## Layout
 *
 * Two lines of text next to one shrink-proof button, which holds up in a 320px
 * phone sheet and in the settings dialog without a breakpoint: the action title
 * and the agent line each truncate, and the button never does. No container query
 * here on purpose — the approval card needs one because it has a genuinely
 * different arrangement at two widths; this has one arrangement that works at all
 * of them.
 */
export function StandingPermissionList({ permissions, className }: StandingPermissionListProps) {
  const now = useNow(30_000);
  const revoke = useRevokeStandingPermission();
  const names = agentNames(permissions);

  return (
    <ul className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {permissions.map((permission) => (
        <li
          key={permission.grantId}
          data-slot="standing-permission"
          className="bg-muted/40 flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm">{permission.capabilityTitle}</p>
            <p className="text-muted-foreground truncate text-xs">
              <span title={permission.agentPath}>{names.get(permission.grantId)}</span>
              {' · '}
              <span className="tabular-nums">{formatTimeLeft(permission.expiresAt, now)}</span>
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2.5 text-xs"
            disabled={revoke.isPending}
            // The accessible name carries the pair, because "Stop trusting" on its
            // own is the same string on every row and tells a screen reader user
            // nothing about which one they are on.
            aria-label={`Stop trusting ${names.get(permission.grantId)} with ${permission.capabilityTitle}`}
            onClick={() => revoke.mutate(permission.grantId)}
          >
            Stop trusting
          </Button>
        </li>
      ))}
    </ul>
  );
}
