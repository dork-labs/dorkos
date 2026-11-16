import type { WakerOff } from '@dorkos/shared/waker-schemas';

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

/**
 * When it stopped, as one absolute date and time ("Nov 14, 11:40 pm"). A
 * relative time drifts while the page stays open and reads wrong across
 * midnight ("since 3h ago"), and these lines are read days later.
 */
export function sinceWords(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time.toLowerCase()}`;
}

/**
 * The line's status: since when it cannot wake, why, and who can turn it back
 * on. A schedule's time is when it first stopped, whatever stopped it, so the
 * reason follows the time rather than claiming it (an approval asked later
 * does not move it). A paused agent's time is the pause's own.
 */
export function wakerStatus(waker: WakerOff): string {
  const person = waker.waitingOn.name ?? 'a person';
  const lead = waker.kind === 'heartbeat' && waker.state === 'paused' ? 'Paused' : 'Off';
  const since = waker.offSince ? `${lead} since ${sinceWords(waker.offSince)}` : lead;
  if (waker.state === 'waiting') return `${since}, needs approval from ${person}.`;
  if (waker.state === 'paused' && waker.kind === 'schedule') {
    return `${since}, its file is missing, waiting on ${person}.`;
  }
  return `${since}, waiting on ${person}.`;
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
