import { useId, useState, type FormEvent } from 'react';
import { roundToCents, TEAMMATE_SPEND_LIMIT_MIN_USD } from '@dorkos/shared/community-teammates';
import { useCommunityTeammates, useUpdateCommunityTeammates } from '@/layers/entities/community';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';

/** Dollars to the cent, as the panel shows an amount. */
function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * The owner's say over teammates in a space (DOR-2956): who may wake their agents here, and the
 * monthly limit on what teammates' turns may cost. "No limit" is the default, said plainly.
 *
 * Shown while the owner may add agents here, or has one here already, even when the space no
 * longer lets them add another.
 */
export function RemoteCommunityTeammates({
  community,
  online,
  canEnroll,
}: {
  community: string;
  online: boolean;
  /** The owner may add an agent here, so the settings show even before one is added. */
  canEnroll: boolean;
}) {
  const id = useId();
  const teammates = useCommunityTeammates(community);
  const update = useUpdateCommunityTeammates(community);
  const spend = teammates.data?.spend;
  // What the person typed, or `null` while the field shows the saved limit.
  const [draft, setDraft] = useState<string | null>(null);
  const saved = spend?.monthlyLimitUsd != null ? String(spend.monthlyLimitUsd) : '';
  const limit = draft ?? saved;
  const typed = limit.trim() === '' ? null : roundToCents(Number(limit));
  const valid = typed === null || (Number.isFinite(typed) && typed >= TEAMMATE_SPEND_LIMIT_MIN_USD);
  const changed = typed !== (spend?.monthlyLimitUsd ?? null);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || !changed || update.isPending) return;
    update.mutate({ monthlyLimitUsd: typed }, { onSuccess: () => setDraft(null) });
  }
  if (!canEnroll && !spend?.hasAgentsHere) return null;
  return (
    <section className="mt-3 space-y-2 border-t pt-3" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        Teammates
      </h3>
      {teammates.isError && (
        <p role="alert" className="text-sm">
          Couldn’t load teammate settings.{' '}
          <Button variant="ghost" size="sm" onClick={() => void teammates.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {teammates.data && spend && (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${id}-wake`}>Who can wake your agents</Label>
            <Select
              value={teammates.data.wakeAgentsFrom}
              onValueChange={(value) =>
                update.mutate({ wakeAgentsFrom: value === 'me' ? 'me' : 'members' })
              }
              disabled={!online || update.isPending}
            >
              <SelectTrigger id={`${id}-wake`} className="max-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="members">Anyone in this space</SelectItem>
                <SelectItem value="me">Only me</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <form onSubmit={save} className="space-y-1">
            <Label htmlFor={`${id}-limit`}>Monthly limit for teammates</Label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm" aria-hidden>
                $
              </span>
              <Input
                id={`${id}-limit`}
                inputMode="decimal"
                value={limit}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="No limit"
                aria-invalid={!valid}
                disabled={!online || update.isPending}
                className="w-32"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!online || !valid || !changed || update.isPending}
              >
                Save
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {spend.monthlyLimitUsd === null
                ? 'No limit'
                : `Limit ${dollars(spend.monthlyLimitUsd)} a month`}
              {` · ${dollars(spend.spentUsd)} spent this month${spend.approximate ? ', approximate' : ''}`}
            </p>
            <p className="text-muted-foreground text-xs">
              Past the limit, teammates’ messages wake nobody. A running turn may go slightly over.
            </p>
            {!valid && (
              <p role="alert" className="text-destructive text-xs">
                Enter at least $0.01, or leave it empty.
              </p>
            )}
          </form>
          {update.isError && (
            <p role="alert" className="text-destructive text-sm">
              Couldn’t save. Try again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
