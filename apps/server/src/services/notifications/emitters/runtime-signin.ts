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
import { setRuntimeSigninSink } from '../../observability/index.js';
import { notify, resolveStanding } from '../notification-service.js';
import { armEscalation } from '../escalation-service.js';

/**
 * Say something when a runtime's sign-in stops working, and stop saying it when
 * it works again.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
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
  return () => setRuntimeSigninSink(null);
}
