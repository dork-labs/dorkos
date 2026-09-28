import { useState, type ReactNode } from 'react';
import { ArrowRight, Clock, type LucideIcon } from 'lucide-react';
import type { LimitHistoryEntry, LimitResolution } from '@dorkos/shared/account-usage';
import { useAccountIdentityGate } from '@/layers/entities/runtime';
import { useModels, useSessionId } from '@/layers/entities/session';
import { useSessionAccount } from '@/layers/features/status';
import { AccountDot } from '@/layers/shared/ui';
import { formatResetTime, limitSubject } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { episodeFor, isEpisodeOf, switchedModels } from '../lib/limit-marker';
import { useAccountNamer } from '../model/use-account-namer';
import { useLimitHistory } from '../model/use-limit-history';

/** The marker's small icon per resolution (Q10): an arrow for a move, a clock for a resume. */
const MARKER_ICONS: Record<LimitResolution, LucideIcon> = {
  moved: ArrowRight,
  'resumed-reset': Clock,
  'resumed-model': Clock,
  'resumed-early': Clock,
};

/** Props for {@link AccountLimitMarkerLine}. */
export interface AccountLimitMarkerLineProps {
  /** The resolved episode. */
  entry: LimitHistoryEntry;
  /** A fixed moment to read times from (tests and the Dev Playground); else the clock. */
  now?: Date;
}

/**
 * One resolved episode as a muted line in the transcript (spec
 * `claude-account-ui` §6.7): "Acct 4 ran out · moved to ● Acct 2 at 2:14pm"
 * (the new account opens the session the work moved to), "Resumed after reset
 * at 4:02pm", "Opus ran out · continued on Sonnet at 4:02pm", or "Acct 4 ran
 * out · continued here at 4:02pm". Names follow `limitSubject`, so a Codex
 * episode reads "Codex ran out · …". A model switch is only claimed when the
 * new model is known; otherwise it reads as continuing here.
 */
export function AccountLimitMarkerLine({ entry, now: fixedNow }: AccountLimitMarkerLineProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  const nameOf = useAccountNamer();
  const identityGate = useAccountIdentityGate(entry.runtime);
  const models = useModels({ runtime: entry.runtime }).data ?? [];
  const [, setSessionId] = useSessionId();

  // Only Claude Code has a registry to name its accounts from.
  const ownLabel =
    entry.runtime === 'claude-code' && entry.accountId ? nameOf(entry.accountId).name : null;
  const subject = limitSubject({ runtime: entry.runtime, accountLabel: ownLabel, identityGate });
  const at = `at ${formatResetTime(entry.resolvedAt, now)}`;
  const Icon = MARKER_ICONS[entry.resolution];

  let words: ReactNode;
  switch (entry.resolution) {
    case 'moved': {
      const target = entry.toAccountId ? nameOf(entry.toAccountId) : null;
      const targetName = target ? (
        <>
          {identityGate && target.color && (
            <span aria-hidden className="mr-0.5 inline-flex align-middle">
              <AccountDot color={target.color} name={target.name} tooltip={false} />
            </span>
          )}
          {target.name}
        </>
      ) : null;
      words = (
        <>
          {subject} ran out · moved
          {targetName && (
            <>
              {' to '}
              {entry.toSessionId ? (
                <button
                  type="button"
                  className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2"
                  onClick={() => setSessionId(entry.toSessionId!)}
                >
                  {targetName}
                </button>
              ) : (
                targetName
              )}
            </>
          )}{' '}
          {at}
        </>
      );
      break;
    }
    case 'resumed-reset':
      words = `Resumed after reset ${at}`;
      break;
    case 'resumed-model': {
      const { from, to } = switchedModels(entry, models);
      words = to
        ? `${from ?? subject} ran out · continued on ${to} ${at}`
        : `${subject} ran out · continued here ${at}`;
      break;
    }
    case 'resumed-early':
      words = `${subject} ran out · continued here ${at}`;
      break;
  }

  return (
    <p
      data-slot="account-limit-marker"
      data-resolution={entry.resolution}
      className="text-muted-foreground text-2xs my-2 flex items-center gap-1.5"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0">{words}</span>
    </p>
  );
}

/** Props for {@link AccountLimitMarker}. */
export interface AccountLimitMarkerProps {
  /** The session the turn belongs to. */
  sessionId: string;
  /** The timestamp of the message holding the turn's `rate_limit` error; empty on a live turn. */
  at: string;
  /** What to show when no history row matches: the plain error card. */
  fallback: ReactNode;
  /** A fixed moment to read times from (tests and the Dev Playground); else the clock. */
  now?: Date;
}

/**
 * What a turn's `rate_limit` error shows in the transcript (spec
 * `claude-account-ui` §6.7, option A): nothing while that episode's banner is
 * up (the banner is where the person acts), then one muted line saying how it
 * ended ({@link AccountLimitMarkerLine}). An episode older than the history
 * (no row within five minutes of the message) keeps the plain error card.
 */
export function AccountLimitMarker({ sessionId, at, fallback, now }: AccountLimitMarkerProps) {
  const { limit } = useSessionAccount(sessionId, { fetchUsage: false });
  const history = useLimitHistory(sessionId);
  // How far the history had got while this episode was still open. Until it
  // has been read again after the limit cleared, the row for this episode
  // cannot be in it yet, so the card waits instead of flashing in. Any later
  // refetch (a window regaining focus) never hides anything.
  const [readWhileOpen, setReadWhileOpen] = useState<{ data: number; error: number } | null>(null);

  // This episode is still open: its banner above the message box speaks for
  // it. A live turn's message has no timestamp yet, and its limit is the open one.
  const open = limit !== null && (at === '' || isEpisodeOf(limit.since, at));
  if (
    open &&
    (readWhileOpen?.data !== history.dataUpdatedAt ||
      readWhileOpen.error !== history.errorUpdatedAt)
  ) {
    setReadWhileOpen({ data: history.dataUpdatedAt, error: history.errorUpdatedAt });
  }
  if (open) return null;
  // Nothing flashes in while the history loads.
  if (history.isPending) return null;
  const entry = history.data && at ? episodeFor(history.data.entries, at) : null;
  if (entry) return <AccountLimitMarkerLine entry={entry} now={now} />;
  const awaitingRow =
    limit === null &&
    readWhileOpen !== null &&
    history.dataUpdatedAt === readWhileOpen.data &&
    history.errorUpdatedAt === readWhileOpen.error;
  return awaitingRow ? null : <>{fallback}</>;
}
