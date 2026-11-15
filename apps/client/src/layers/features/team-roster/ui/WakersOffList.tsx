import type { WakerOff } from '@dorkos/shared/waker-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';

/** Props for {@link WakersOffList}. */
export interface WakersOffListProps {
  /** Every schedule and heartbeat that cannot wake now, longest off first. */
  wakers: WakerOff[];
}

/** What a waker is called on its line. */
function wakerTitle(waker: WakerOff): string {
  if (waker.kind === 'schedule' || waker.agentId === null) return waker.name;
  // A paused agent stops all its work, not just its heartbeat.
  return waker.state === 'paused' ? `${waker.name} (agent)` : `${waker.name}’s heartbeat`;
}

/** When it stopped, in the app's time words: a clock time today, else a day. */
function sinceWords(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return formatRelativeTime(iso).replace(/^Yesterday/, 'yesterday');
}

/** The line's status: why it cannot wake, since when, and who can turn it back on. */
export function wakerStatus(waker: WakerOff): string {
  const verb =
    waker.state === 'waiting' ? 'Needs approval' : waker.state === 'paused' ? 'Paused' : 'Off';
  const since = waker.offSince ? ` since ${sinceWords(waker.offSince)}` : '';
  return `${verb}${since}, waiting on ${waker.waitingOn.name ?? 'a person'}.`;
}

/**
 * One line for every schedule and heartbeat that is switched off or parked, so
 * a waker that stopped never goes unnoticed (DOR-3641). Draws nothing when
 * every waker is on.
 */
export function WakersOffList({ wakers }: WakersOffListProps) {
  if (wakers.length === 0) return null;
  return (
    <section aria-labelledby="team-wakers-off" className="flex flex-col gap-2 pt-2">
      <h2 id="team-wakers-off" className="text-sm font-medium">
        Off or waiting
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {wakers.map((waker) => (
          <li
            key={`${waker.kind}:${waker.id}`}
            data-slot="waker-off"
            className="flex min-w-0 flex-wrap gap-x-2"
          >
            <span className="truncate font-medium" title={wakerTitle(waker)}>
              {wakerTitle(waker)}
            </span>
            <span
              className="text-muted-foreground"
              title={waker.offSince ? new Date(waker.offSince).toLocaleString() : undefined}
            >
              {wakerStatus(waker)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
