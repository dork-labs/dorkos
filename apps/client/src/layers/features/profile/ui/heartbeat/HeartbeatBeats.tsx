/**
 * The Heartbeat page's last checks: when each ran, what kind it was, the line
 * it left in the record, and how it ended (spec `heartbeats` §7.6, §11).
 *
 * @module features/profile/ui/heartbeat/HeartbeatBeats
 */
import type { BeatSummary } from '@dorkos/shared/heartbeat-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { formatRelativeTime, toSession } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import { BEAT_KIND_LABEL, BEAT_OUTCOME_BADGE } from '../../lib/heartbeat-words';

/** Props for {@link HeartbeatBeats}. */
export interface HeartbeatBeatsProps {
  /** The last checks, newest first. */
  beats: readonly BeatSummary[];
  /**
   * The moment "5m ago" is read from. Passed in so a ticking parent redraws
   * the times; `formatRelativeTime` reads the clock itself on each render.
   */
  now: number;
  /** Whether a beat's chat may be opened. False while heartbeats are off for everyone. */
  canOpenChat: boolean;
}

/** A beat's start as a full date and time, for its tooltip and its button's name. */
function startedWords(started: Date): string | null {
  if (Number.isNaN(started.getTime())) return null;
  return started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One past check. */
function BeatRow({ beat, onOpenChat }: { beat: BeatSummary; onOpenChat?: () => void }) {
  const badge = BEAT_OUTCOME_BADGE[beat.outcome];
  const at = startedWords(new Date(beat.startedAt));
  return (
    <li
      data-slot="heartbeat-beat"
      data-outcome={beat.outcome}
      className="flex flex-col gap-1 rounded-md px-2 py-2"
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time dateTime={beat.startedAt} title={at ?? undefined}>
          {formatRelativeTime(beat.startedAt)}
        </time>
        <span>{BEAT_KIND_LABEL[beat.kind]}</span>
        <Badge variant="outline" size="xs" tone={badge.tone} className="ml-auto">
          {badge.label}
        </Badge>
      </div>
      {beat.summary && <p className="text-sm break-words">{beat.summary}</p>}
      {onOpenChat && (
        <Button
          size="xs"
          variant="ghost"
          className="-ml-2 self-start"
          aria-label={at ? `Open chat from the check at ${at}` : 'Open chat from this check'}
          onClick={onOpenChat}
        >
          Open chat
        </Button>
      )}
    </li>
  );
}

/** The last checks, or one line saying there are none. */
export function HeartbeatBeats({ beats, canOpenChat }: HeartbeatBeatsProps) {
  const navigate = useSafeNavigate();
  if (beats.length === 0) {
    return <p className="text-muted-foreground px-2 text-sm">No checks yet.</p>;
  }
  return (
    <ul className="flex flex-col" aria-label="Last checks">
      {beats.map((beat) => {
        // The beat chat, only when the server says which one it was: it is the
        // agent's own chat, and the server names it only to whoever may open it.
        // By id alone: `toSession` drops any `dir`, and the server finds the
        // chat's folder from its own binding.
        const sessionId = beat.sessionId;
        const open =
          canOpenChat && sessionId && navigate
            ? () => void navigate(toSession({ session: sessionId }))
            : undefined;
        return <BeatRow key={beat.id} beat={beat} {...(open ? { onOpenChat: open } : {})} />;
      })}
    </ul>
  );
}
