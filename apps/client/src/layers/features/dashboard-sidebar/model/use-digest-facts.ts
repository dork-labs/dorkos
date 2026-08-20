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
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { markDigestShown, useUpdateSidebarPrefs, useWelcomeBack } from '@/layers/entities/config';
import type { InteractionTimestamps } from '@/layers/entities/interactions';
import { localDateKey } from './rules/build-digest-row';
import type { DigestState } from './sidebar-state';

/**
 * How long a session has to have sat still before the digest calls it idle.
 *
 * Thirty minutes, inherited from the idle nudge this replaced: a shorter window
 * reports a coffee break. The threshold is the only thing kept — the nudge
 * itself was a row in Heads up asking for attention on a guess, and this is a
 * line in a once-a-day summary about what already happened (DOR-1391).
 *
 * **The boundary is inclusive: still for exactly thirty minutes counts.** Either
 * side is defensible at the instant itself, and inclusive is the one that keeps
 * the constant's own sentence true — "sat still for thirty minutes" is a
 * description of a session that has, not of one that has sat still for thirty
 * minutes and a millisecond. Pinned by a test at exactly this value.
 */
export const IDLE_SESSION_AFTER_MS = 30 * 60 * 1000;

/**
 * The digest with nothing in it — one shared object, so a gate that says no
 * never mints a fresh identity and rebuilds the model with it.
 */
const NO_DIGEST: DigestState = { finishedWhileAwayCount: 0, idleWhileAwayCount: 0 };

/** What {@link useDigestFacts} reads. */
export interface UseDigestFactsInput {
  /** The model's clock, epoch ms. */
  now: number;
  /** Every session the cockpit can see. */
  sessions: readonly Session[];
  /** The sessions streaming a turn right now — still working, so not news. */
  workingSessionIds: readonly string[];
  /**
   * Session id → coarse lifecycle, for the one thing the idle count needs to
   * know: whether a still session is still because it stopped, or because it is
   * parked on a person. A blocked or wedged session is already a Heads up row
   * and must not be counted as idle on top of it.
   */
  sessionStatuses: Readonly<Record<string, SessionLifecycle>>;
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
 * signal `rooms/welcome-back/greeter.ts` calls `personSeen`: a thing this person opened.
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
 * How many sessions moved during the absence and have been still since.
 *
 * **This is what became of the "Went quiet" row** (DOR-1391). Heads up used to
 * carry one dismissible nudge about the most recently touched idle session,
 * which asked for attention on a heuristic; the observation was worth keeping
 * and the interruption was not. Here it is one clause in a summary a person
 * reads once a day, in the past tense, about a stretch of time they were not
 * watching.
 *
 * **It counts stillness and says exactly that.** A session that finished its
 * work cleanly and one that stalled mid-task are the same shape here — a
 * `updatedAt` that stopped moving — because nothing on the record marks a clean
 * end. The row calls them "idle" rather than "gone quiet" for that reason; see
 * `build-digest-row`.
 *
 * Same three conditions the nudge applied, minus its limit of one: the session
 * is not streaming, it is not parked on a person or wedged — those are Heads up
 * rows in their own right and would be counted twice — and it has been still
 * for at least {@link IDLE_SESSION_AFTER_MS}.
 *
 * **The window is the absence, not the 4am boundary**, matching the fact beside
 * it. The boundary is what decides which local DAY the digest has already been
 * shown for (`localDateKey`, and Today's own `archiveOvernight`); the absence is
 * what the digest is ABOUT, and a person who was away from 20:00 to 09:00 was
 * away for all of it, not just for the hours after four in the morning.
 *
 * @param sessions - Every session the cockpit can see.
 * @param workingSessionIds - The ones still streaming.
 * @param statuses - Session id → coarse lifecycle.
 * @param since - When the absence began, epoch ms.
 * @param until - The model's clock, epoch ms.
 */
function countIdleWhileAway(
  sessions: readonly Session[],
  workingSessionIds: readonly string[],
  statuses: Readonly<Record<string, SessionLifecycle>>,
  since: number,
  until: number
): number {
  const working = new Set(workingSessionIds);
  let count = 0;
  for (const session of sessions) {
    if (working.has(session.id)) continue;
    const lifecycle = statuses[session.id];
    if (lifecycle === 'streaming' || lifecycle === 'blocked' || lifecycle === 'error') continue;
    const at = Date.parse(session.updatedAt);
    if (Number.isNaN(at)) continue;
    if (at <= since || at > until) continue;
    if (until - at < IDLE_SESSION_AFTER_MS) continue;
    count += 1;
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
 * **The dismissal is "the newest interaction record moved", and that now covers
 * nearly every way in.** The sidebar's own rows (`SidebarChrome.openTarget`)
 * record one, and so does ⌘K (`use-palette-actions`, which since P3.3 records
 * the agent, room or conversation every row it offers lands you in — including
 * the conversation a slash-command row types into). DOR-1156 added the rest:
 * the presence strip, the "Jump back in" popover, the attention rows and
 * `/team`'s profile drawer each record what they open, and writing a message
 * records the conversation you wrote it in — the strongest signal there is,
 * since BC-16 already treats what you WROTE as attention.
 *
 * It is a record of PLACES, not of acts: choosing "Toggle theme" from ⌘K
 * records nothing and dissolves nothing, which is deliberate and argued at
 * `InteractionKind`.
 *
 * **Two ways in still leave the row standing, both on purpose.** Landing on the
 * home surface records nothing — `/` IS #team, and it is arrived at rather than
 * opened, so a write there would fire on every page load and dissolve this row
 * before anybody read it. A deep link into a session records nothing for the
 * same reason. (`useStartNewSession` records nothing either, but for a
 * different reason: it mints an id no session list holds yet, so a record would
 * name a row nothing can draw — the first message writes one.) All of them
 * still put the row away on the next load, because `lastShownDate` was written
 * the moment it rendered.
 *
 * Closing the deep-link case is one write inside `entities/session`'s
 * navigation seams — `useDirectoryState`'s setter already takes the `onOpened`
 * hook ⌘K uses, which is how an entity that may not import `entities/interactions`
 * can still record. That is an entity edit wanting its own task with that
 * entity's owner rather than a quiet addition from a feature.
 *
 * @param input - The clock, the sessions, the interactions and stored prefs.
 */
export function useDigestFacts(input: UseDigestFactsInput): DigestFacts {
  const { now, sessions, workingSessionIds, sessionStatuses, interactions, storedLastShownDate } =
    input;
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
    if (dissolved) return NO_DIGEST;
    if (!welcomeBack.isAvailable || !welcomeBack.enabled) return NO_DIGEST;
    if (welcomeBack.maxPosts <= 0) return NO_DIGEST;
    if (seen === null) return NO_DIGEST;
    if (now - seen < welcomeBack.absenceThresholdMinutes * 60_000) return NO_DIGEST;
    return {
      finishedWhileAwayCount: countFinishedWhileAway(sessions, workingSessionIds, seen, now),
      idleWhileAwayCount: countIdleWhileAway(
        sessions,
        workingSessionIds,
        sessionStatuses,
        seen,
        now
      ),
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
    sessionStatuses,
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
