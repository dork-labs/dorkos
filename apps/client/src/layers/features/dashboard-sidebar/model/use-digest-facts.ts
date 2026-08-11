/**
 * "While you were away…" — what the digest row is a function of, and the one
 * write it makes (BC-22).
 *
 * Two halves live here, and neither belongs in a rule. The COUNT is a client
 * derivation over live queries; the MEMORY is a write to server-held prefs. The
 * rule beside it (`rules/build-digest-row.ts`) stays a pure function of the
 * snapshot both halves land in.
 *
 * @module features/dashboard-sidebar/model/use-digest-facts
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@dorkos/shared/types';
import { markDigestShown, useUpdateSidebarPrefs, useWelcomeBack } from '@/layers/entities/config';
import type { InteractionTimestamps } from '@/layers/entities/interactions';
import { localDateKey } from './rules/build-digest-row';
import type { DigestState } from './sidebar-state';

/** What {@link useDigestFacts} reads. */
export interface UseDigestFactsInput {
  /** The model's clock, epoch ms. */
  now: number;
  /** Every session the cockpit can see. */
  sessions: readonly Session[];
  /** The sessions streaming a turn right now — still working, so not news. */
  workingSessionIds: readonly string[];
  /** When the operator last opened anything, from `entities/interactions`. */
  interactions: InteractionTimestamps;
  /** The stored `lastShownDate`, as prefs currently report it. */
  storedLastShownDate: string | undefined;
}

/** What {@link useDigestFacts} answers with. */
export interface DigestFacts {
  /** The digest's content, for {@link DigestState}. */
  digest: DigestState;
  /**
   * The date the rule must judge against — **latched**, not the live pref.
   *
   * BC-22 says the memory is written "the moment it renders" and that the row
   * "dissolves when the user opens any conversation". Those two are only
   * compatible if the write does not feed straight back into the rule that
   * drew the row: writing today's date into a live pref would make the row
   * vanish on the very next rebuild, a few milliseconds after appearing. So
   * the value handed to the rule is the one this tab loaded with, and the
   * write goes to prefs where the next load — on this machine or any other —
   * reads it.
   */
  lastShownDate: string | undefined;
}

/**
 * When the operator was last demonstrably here, epoch ms, or `null` when this
 * device has never seen them.
 *
 * The newest interaction record, which is the client's own version of the
 * signal `welcome-back.ts` calls `personSeen`: a thing this person opened.
 * `null` — never `0` — because "never" and "at the epoch" are different facts,
 * and only one of them can produce an absence.
 *
 * @param interactions - Every interaction timestamp.
 */
function lastSeenAt(interactions: InteractionTimestamps): number | null {
  let newest: number | null = null;
  for (const iso of Object.values(interactions)) {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/**
 * How many pieces of work finished while the operator was away.
 *
 * **Derived from what the cockpit already fetched, and never invented.** A
 * session whose `updatedAt` falls inside the absence moved while nobody was
 * watching; a session still streaming has not finished, so it is not news yet.
 * Automated runs count here and only here: BC-19 keeps them out of Today's
 * rows, and design-decisions §353 keeps them out of every liveness signal —
 * both are about what is happening NOW, and this is a report about what already
 * happened. A scheduled overnight run finishing is precisely the thing a person
 * comes back to.
 *
 * @param sessions - Every session the cockpit can see.
 * @param workingSessionIds - The ones still streaming.
 * @param since - When the absence began, epoch ms.
 * @param until - The model's clock, epoch ms.
 */
function countFinishedWhileAway(
  sessions: readonly Session[],
  workingSessionIds: readonly string[],
  since: number,
  until: number
): number {
  const working = new Set(workingSessionIds);
  let count = 0;
  for (const session of sessions) {
    if (working.has(session.id)) continue;
    const at = Date.parse(session.updatedAt);
    if (Number.isNaN(at)) continue;
    if (at > since && at <= until) count += 1;
  }
  return count;
}

/**
 * The digest's content and the date the rule judges it against.
 *
 * **Five gates, and every one of them can say no.**
 *
 * 1. The install has to have the welcome-back setting and have it switched on.
 *    A person who turned "greet me when I get back" off has answered this
 *    question already, and the sidebar is not a second place to ask it.
 * 2. It has to allow at least one post. `maxPosts: 0` is a legitimate value the
 *    server honours (`planWelcomeBack` slices to it), and it means no note will
 *    be written — so a row promising one would be a door onto an empty room.
 * 3. This device has to have seen the operator before, or there is no absence
 *    to measure — only a first visit.
 * 4. The absence has to clear the same threshold the greeting uses
 *    (`welcomeBack.absenceThresholdMinutes`), so lunch is not a homecoming.
 * 5. Something has to actually have finished. A "while you were away" that
 *    reports nothing is a product inventing an event to have a moment about.
 *
 * The write happens in an effect, once, the first time a real count survives
 * all five — and the value the rule reads stays latched at what this tab loaded
 * with, so the row survives its own memory being written. See
 * {@link DigestFacts.lastShownDate}.
 *
 * **The dismissal is narrower than BC-22's words, deliberately and for now.**
 * "It dissolves when the user opens any conversation" is implemented as "the
 * newest interaction record moved", and only `SidebarChrome.openTarget` writes
 * one — so opening a conversation from ⌘K or from the home surface does not put
 * the row away within this browser session. It still goes on the next load,
 * because `lastShownDate` was written the moment it rendered, so the failure is
 * one stale row for one session rather than a repeated moment. Widening it
 * means every open path recording an interaction, which is P3's job: it retires
 * `dorkos:agent-frecency-v2` into this same store and makes ⌘K a writer
 * (`entities/interactions`, module note). Doing it here would put a write into
 * three sibling features this task does not own.
 *
 * @param input - The clock, the sessions, the interactions and stored prefs.
 */
export function useDigestFacts(input: UseDigestFactsInput): DigestFacts {
  const { now, sessions, workingSessionIds, interactions, storedLastShownDate } = input;
  const welcomeBack = useWelcomeBack();
  const { update } = useUpdateSidebarPrefs();

  // Latched at mount. Reading the live pref would make the row erase itself
  // the moment it recorded that it had appeared.
  const [lastShownDate] = useState(() => storedLastShownDate);

  // "Opened any conversation" — the dissolve (BC-22). Compared by VALUE, not by
  // the map's identity: identity happens to be stable in the running app
  // (`useInteractionTimestamps` hands back the store's own object) and a hook
  // whose behaviour depended on that would dissolve on any caller that rebuilt
  // its input. The newest record moving forward is what opening something
  // actually does, whoever assembled the map.
  const [baseline] = useState(() => lastSeenAt(interactions));
  const seen = lastSeenAt(interactions);
  const dissolved = seen !== null && (baseline === null || seen > baseline);

  const digest = useMemo<DigestState>(() => {
    if (dissolved) return { finishedWhileAwayCount: 0 };
    if (!welcomeBack.isAvailable || !welcomeBack.enabled) return { finishedWhileAwayCount: 0 };
    if (welcomeBack.maxPosts <= 0) return { finishedWhileAwayCount: 0 };
    if (seen === null) return { finishedWhileAwayCount: 0 };
    if (now - seen < welcomeBack.absenceThresholdMinutes * 60_000) {
      return { finishedWhileAwayCount: 0 };
    }
    return {
      finishedWhileAwayCount: countFinishedWhileAway(sessions, workingSessionIds, seen, now),
    };
  }, [
    dissolved,
    welcomeBack.isAvailable,
    welcomeBack.enabled,
    welcomeBack.absenceThresholdMinutes,
    welcomeBack.maxPosts,
    seen,
    now,
    sessions,
    workingSessionIds,
  ]);

  // The row is about to render iff both halves of BC-22 hold — the same two
  // conditions `buildDigestRow` applies, asked here because this is where the
  // write lives. A third spelling of them would be a third thing to keep in
  // step; a call into the rule would need a whole snapshot to answer one bit.
  const today = localDateKey(now);
  const showing = digest.finishedWhileAwayCount > 0 && lastShownDate !== today;
  const written = useRef(false);
  useEffect(() => {
    if (!showing || written.current) return;
    written.current = true;
    update((prev) => markDigestShown(prev, today));
  }, [showing, today, update]);

  return { digest, lastShownDate };
}
