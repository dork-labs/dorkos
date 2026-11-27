/**
 * The beat chat (spec `heartbeats` §7.1): one chat per agent per local day in
 * its chain person's zone, titled "Heartbeat · {weekday} {date}".
 *
 * A beat that starts before midnight finishes in its own chat; the next beat
 * opens the new day's. A new chat each day keeps a beat from reloading a long
 * history (canon §7, "Beats run light"). The (agent, date) → chat mapping is
 * `heartbeat_state.beat_chat_id` / `beat_chat_date`. The chat list labels it
 * "Heartbeat" (`session/origin/heartbeat-origin-overlay.ts`, beside the other
 * origin overlays; the beat lookup it reads is handed in from here).
 *
 * @module services/heartbeats/beat-chat
 */
import { randomUUID } from 'node:crypto';
import { HEARTBEAT_ORIGIN_LABEL } from '@dorkos/shared/heartbeat-schemas';
import { zonedDay } from '@dorkos/shared/working-hours';

/** Today's beat chat for an agent. */
export interface BeatChat {
  /** The chat id. */
  sessionId: string;
  /** The local date it belongs to, `YYYY-MM-DD`. */
  date: string;
  /** Whether this beat opens it. */
  isNew: boolean;
  /** Its title. */
  title: string;
}

/**
 * The title for a day's beat chat, e.g. "Heartbeat · Monday Oct 12".
 *
 * @param now - The moment, read in `zone`.
 * @param zone - The chain person's IANA zone.
 */
export function beatChatTitle(now: Date, zone: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: zone }).format(now);
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(now);
  return `${HEARTBEAT_ORIGIN_LABEL} · ${weekday} ${date}`;
}

/**
 * Today's beat chat: the stored one when it is today's, else a new id.
 *
 * @param stored - The agent's stored beat chat and its date.
 * @param stored.beatChatId - The chat id, or null.
 * @param stored.beatChatDate - Its local date, or null.
 * @param now - The moment.
 * @param zone - The chain person's IANA zone.
 * @param mintId - Mints a chat id; tests pin it.
 */
export function resolveBeatChat(
  stored: { beatChatId: string | null; beatChatDate: string | null } | undefined,
  now: Date,
  zone: string,
  mintId: () => string = randomUUID
): BeatChat {
  const date = zonedDay(now, zone);
  const title = beatChatTitle(now, zone);
  if (stored?.beatChatId && stored.beatChatDate === date) {
    return { sessionId: stored.beatChatId, date, isNew: false, title };
  }
  return { sessionId: mintId(), date, isNew: true, title };
}
