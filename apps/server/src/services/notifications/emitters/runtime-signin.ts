/**
 * Turns a dead runtime sign-in into something the operator actually sees — and
 * into something that stops bothering them the moment they fix it (DOR-1654,
 * DOR-1657).
 *
 * The noticing happens in `services/observability/runtime-signin-watch.ts`, wrapped
 * around every runtime at the one registration seam every turn passes through —
 * the interactive composer, a room reply, a scheduled run and an agent-to-agent
 * relay delivery alike. That module deliberately says nothing itself, so
 * `runtime-registry.ts` does not have to import the notification pipeline (and
 * the relay channel, and the store) behind it. This is the other half: what to
 * say, and it is the only half that knows about notifications at all.
 *
 * ## Two edges, one episode
 *
 * `signin.required` is a `standing-recorded` condition (DOR-1657), so each edge
 * both stores something and moves the ladder:
 *
 * - **Failing** — {@link notify} writes the durable row (unread, so the bell
 *   lights and the desktop draws its banner), and {@link armEscalation} starts
 *   the clock that reaches a phone when nobody signs in.
 * - **Recovered** — {@link resolveStanding} disarms that clock and writes the
 *   second row, which says the sign-in is working again. `cleared` is its
 *   outcome for the same reason `session.error` uses it: the condition ended
 *   without anybody answering a prompt. That row lands already read, so a
 *   sign-in somebody just fixed does not light the bell or raise a banner.
 *
 * Both carry the episode's own `since`, exactly as the watch stamped it, so the
 * key the ladder armed under is the key the resolution disarms.
 *
 * There is a third moment, and it is boot: a server killed mid-episode leaves a
 * raise row that no recovery edge can ever answer, because the episode store
 * went with the process. {@link retireOrphanedEpisodes} closes those rows on the
 * way in — see it for why that is the honest move rather than a guess.
 *
 * ## Why the arrival is not announced with `raiseStanding`
 *
 * Every other standing kind announces itself on `standing_pending`, because it
 * stores nothing and that event is the only thing a desktop banner could be
 * drawn from. This kind stores a row at the raise edge, and the desktop draws a
 * banner from THAT — the two paths have no dedupe between them
 * (`apps/desktop/src/main/notifications/index.ts` keys one on notification id
 * and the other on `subjectKey`), so announcing as well would put two banners on
 * screen for one dead credential. `session.error` arms the ladder directly for
 * the same reason, and this follows it.
 *
 * ## What a failed row write costs, stated plainly
 *
 * DOR-1654 had a release path here: the watch claims its episode BEFORE the sink
 * runs, so a `notify()` that then stored nothing left the runtime silent for an
 * hour on the strength of a notification that never happened, and giving the
 * claim back handed the next failing turn another go.
 *
 * There is no release now, and the cost is real rather than theoretical.
 * `notify()` swallows a store failure and answers "nothing stored", and **later
 * failing turns on the same runtime do not retry it** — they find the episode
 * already claimed (`failingSince.has`) and return having done nothing. So a
 * failed write loses that episode's row outright; the next row comes only with
 * the NEXT episode, after this one resolves.
 *
 * That is a chosen trade rather than an oversight, because releasing the claim
 * would strand the timer armed beside it. `armEscalation` files under the
 * episode key (`signin:<runtime>:<since>`), and a resolution cancels only the
 * key it resolves. Release, and the next failing turn mints a new episode under
 * a new key: two live timers for one unbroken stretch of breakage, and the older
 * one still firing after the operator has signed in — a phone telling somebody
 * to go and fix the thing they just fixed. Cancelling the stranded timer as well
 * would avoid that, but then one transient store error costs the PUSH as well as
 * the row, and on a runtime whose only failing turn was a nightly job there is
 * no later turn to correct it.
 *
 * So the escalation goes out regardless of whether the row landed, which is the
 * right way round: the ladder is the leg that reaches somebody who is not here,
 * and the row is the one they find later. The watch declines to claim an episode
 * at all when no sink is installed to hear it, covering the only case where
 * nothing whatsoever would have happened.
 *
 * Installed at boot beside the other emitters, in `index.ts`.
 *
 * @module services/notifications/emitters/runtime-signin
 */
import { isSigninFailing, setRuntimeSigninSink } from '../../observability/index.js';
import { logger } from '../../../lib/logger.js';
import { notify, resolveStanding, unresolvedStanding } from '../notification-service.js';
import { armEscalation } from '../escalation-service.js';

/**
 * Say something when a runtime's sign-in stops working, and stop saying it when
 * it works again — and, first, close the rows a restart orphaned.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
  // Read the orphans BEFORE the sink exists, so the list cannot contain a raise
  // this process made: `noteSigninFailure` returns early while no sink is
  // installed, which is the same reason nothing is claimed before boot wires
  // one. See `retireOrphanedEpisodes` below.
  //
  // Wrapped, because this is the composition root's thread: a locked database
  // (SQLITE_BUSY, another process mid-write at exactly this moment) would
  // otherwise throw out of `index.ts`'s boot sequence and take the whole
  // installation of this watch with it — leaving every runtime UNWATCHED over a
  // tidy-up that was optional. A repair that could not run is worth a log line;
  // it is not worth the feature it is repairing.
  const orphaned = readOrphanedEpisodes();

  setRuntimeSigninSink(({ runtime, edge, since }) => {
    if (edge === 'failing') {
      void notify('signin.required', { runtime, since });
      // Outside the fire-and-forget above, and never awaiting it: the row is
      // what the operator finds later, the clock is what reaches them tonight,
      // and a store that could not write must not also cost the phone leg.
      armEscalation('signin.required', { runtime, since });
      return;
    }
    void resolveStanding(
      'signin.required',
      { runtime, since, clearedAt: new Date().toISOString() },
      { outcome: 'cleared' }
    );
  });

  void retireOrphanedEpisodes(orphaned);
  return () => setRuntimeSigninSink(null);
}

/**
 * The unresolved raise rows, or none when the store could not be asked.
 *
 * @returns What {@link unresolvedStanding} found, or an empty list on any read
 *   failure — boot carries on either way.
 */
function readOrphanedEpisodes(): OrphanedEpisode[] {
  try {
    return unresolvedStanding('signin.required');
  } catch (err) {
    logger.warn('[Runtimes] Could not look for sign-in episodes left open by a restart', { err });
    return [];
  }
}

/** One raise row this process found with nothing after it. */
interface OrphanedEpisode {
  /** The runtime it is about — `subjectId` on the row. */
  subjectId: string;
  /** When the row was written. Always present; it is a column. */
  createdAt: string;
  /** What the row was written from, when it can still be read. */
  payload: unknown;
}

/**
 * Close the raise rows a restart left with nobody to answer them.
 *
 * ## Why history has to be repaired at all
 *
 * The store that answers "is this sign-in still dead?" is `failingSince` (`runtime-signin-watch.ts`),
 * held in MEMORY. Kill the server mid-episode and it goes with it: the next
 * clean turn finds no episode and returns without writing anything, so the
 * resolution row for that episode is never written by anybody, ever. The raise
 * row then sits at the top of that runtime's history saying the sign-in stopped
 * working — with nothing after it — for the rest of the install's life.
 *
 * That was survivable while the Inbox was the only reader: a row is a record of
 * a moment, and it is written in the past tense for exactly that reason. It
 * stopped being survivable when a surface started reading the same rows as the
 * PRESENT tense — the web app's standing banner (DOR-1680) shows a critical row
 * while a runtime's newest `signin.required` row is unresolved, outranks every
 * other banner, and cannot be dismissed. A permanent one is not a stale record,
 * it is a broken app.
 *
 * ## Why closing them is honest, and why the alternative is not
 *
 * Boot does not know the sign-in works — it knows only that nothing in this
 * process can ever find out, because the episode that would have been resolved
 * belonged to a process that is gone. Between "assert a condition nobody can
 * verify" and "close it and let the next failing turn re-raise it within one
 * turn", the second is the same trade `failingSince` (`runtime-signin-watch.ts`) already documents for
 * not re-arming, in the same direction: a late alarm beats a permanent false
 * one, and a sign-in that is still dead re-stands on the very next turn.
 *
 * The resolution row costs nothing on the way out: `signin.required` is
 * `relay: 'never'` so nothing leaves the app, and a `cleared` outcome lands the
 * row already read (`somebodyActed` in `notification-service.ts`), so the bell
 * stays quiet and no banner is raised. What it does is stop the history claiming
 * the present.
 *
 * ## Why a row with no episode stamp is closed anyway
 *
 * **The oldest rows in this table do not carry one.** DOR-1654 shipped
 * `signin.required` as a plain event whose payload was `{ runtime }` and nothing
 * else; `since` arrived with DOR-1657. Every row written in between — and this
 * repo's own dogfood install ran for seventeen hours on that build — has no
 * episode stamp, and so does any row whose stored JSON no longer parses. An
 * earlier draft of this function skipped exactly those rows on the grounds that
 * the episode key is what files a row, its timer and its resolution under one
 * identity. That reasoning was backwards: it protected a key nothing is left to
 * match, at the price of the only rows that are guaranteed to be permanent.
 *
 * Nothing needs the key to match here. `dedupeWindowMs` is 0, so the resolution
 * cannot be suppressed by the raise; the escalation timer it would have
 * cancelled died with the process that armed it (`cancelEscalationByKey` on a
 * key with no timer is a no-op); and no surface draws a standing banner from
 * this kind's `subjectKey` — the desktop draws from the ROW. So the row's own
 * `createdAt` stands in when the payload has no stamp: always present, being a
 * column, and within milliseconds of what the stamp would have said anyway.
 *
 * ## The one row it will not close
 *
 * A runtime this process has ALREADY seen fail keeps its row: `isSigninFailing`
 * is the live episode store, and a row for a condition that is standing right
 * now is not an orphan. The orphan list itself is read before the sink is
 * installed, so it cannot contain a raise this process made; this second check
 * covers a failure that arrives while the writes below are in flight. A failure
 * landing inside the microseconds between that check and its own `await` would
 * still be closed — at boot, before any runtime has been asked to do anything,
 * that is not a reachable window, and the next failing turn corrects it.
 *
 * One row's failure is its own: the write is per-row, so a store that refuses
 * one does not cost the others their repair.
 *
 * @param orphaned - The unresolved raise rows found before the sink was wired.
 */
async function retireOrphanedEpisodes(orphaned: OrphanedEpisode[]): Promise<void> {
  for (const { subjectId, createdAt, payload } of orphaned) {
    if (isSigninFailing(subjectId)) continue;
    const since = episodeStart(payload) ?? createdAt;
    logger.info('[Runtimes] Closing a sign-in episode a restart left open', {
      runtime: subjectId,
    });
    try {
      await resolveStanding(
        'signin.required',
        { runtime: subjectId, since, clearedAt: new Date().toISOString(), closedAtBoot: true },
        { outcome: 'cleared' }
      );
    } catch (err) {
      logger.warn('[Runtimes] Could not close a sign-in episode left open by a restart', {
        err,
        runtime: subjectId,
      });
    }
  }
}

/**
 * The episode identity stored on a raise row, or `null` when the row does not
 * carry one this process can read.
 *
 * Narrowed rather than cast: the payload comes back off disk as `unknown`, and
 * it may have been written by an older version of this file — the rows DOR-1654
 * wrote carry `{ runtime }` and nothing else. `null` is normal, not exceptional;
 * the caller falls back to the row's `createdAt`.
 */
function episodeStart(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const since = (payload as { since?: unknown }).since;
  return typeof since === 'string' && since.length > 0 ? since : null;
}
