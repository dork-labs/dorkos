/**
 * Messages a beat raised for a person, held until their working hours (spec
 * `heartbeats` §9.2). Nothing is hidden: every held message is listed with who
 * it is for and when it arrives, and its text shows to whoever the server lets
 * read it (the server sends `text: null` to anyone else).
 *
 * @module features/profile/ui/heartbeat/HeartbeatHeld
 */
import type { HeldRaise } from '@dorkos/shared/heartbeat-schemas';
import { arrivesWords } from '../../lib/heartbeat-words';

/** Props for {@link HeartbeatHeld}. */
export interface HeartbeatHeldProps {
  /** The held messages. The section draws nothing when there are none. */
  held: readonly HeldRaise[];
  /** Names an account id, for the line under each message. */
  nameOf: (accountId: string) => string;
  /** The moment to read arrival times from. */
  now: number;
}

/** "Held until working hours: N.", each message's recipient and arrival, and its text when readable. */
export function HeartbeatHeld({ held, nameOf, now }: HeartbeatHeldProps) {
  if (held.length === 0) return null;
  return (
    <section className="space-y-2" data-slot="heartbeat-held">
      <h3 className="text-sm font-semibold">Held until working hours: {held.length}.</h3>
      <ul className="flex flex-col" aria-label="Held messages">
        {held.map((raise) => {
          const arrives = arrivesWords(raise.deliverAfter, new Date(now));
          return (
            <li key={raise.id} className="flex flex-col gap-0.5 rounded-md px-2 py-2">
              {raise.text && (
                <p className="line-clamp-3 text-sm break-words whitespace-pre-line">{raise.text}</p>
              )}
              <p className="text-muted-foreground text-xs">
                {[`To ${nameOf(raise.to)}`, arrives].filter(Boolean).join(' · ')}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
