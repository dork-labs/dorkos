/**
 * Messages a beat raised for a person, held until their hours (spec
 * `heartbeats` §9.2). Nothing is hidden: the count always shows, and each
 * message's text shows to whoever the server lets read it.
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
}

/**
 * A held message as the page may read it. The text is the owner's and the
 * recipient's to read; anyone else gets the row without it.
 */
type ReadableRaise = Omit<HeldRaise, 'text'> & { text?: string | null };

/** "Held for your hours: N." and, where they may be read, the messages. */
export function HeartbeatHeld({ held, nameOf }: HeartbeatHeldProps) {
  if (held.length === 0) return null;
  const rows = held as readonly ReadableRaise[];
  const readable = rows.filter((raise) => Boolean(raise.text));
  return (
    <section className="space-y-2" data-slot="heartbeat-held">
      <h3 className="text-sm font-semibold">Held for your hours: {held.length}.</h3>
      {readable.length > 0 && (
        <ul className="flex flex-col" aria-label="Held messages">
          {readable.map((raise) => {
            const arrives = arrivesWords(raise.deliverAfter);
            return (
              <li key={raise.id} className="flex flex-col gap-0.5 rounded-md px-2 py-2">
                <p className="line-clamp-3 text-sm break-words whitespace-pre-line">{raise.text}</p>
                <p className="text-muted-foreground text-xs">
                  {[`To ${nameOf(raise.to)}`, arrives].filter(Boolean).join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
