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
 * `signin.required` is a STANDING condition (DOR-1657), so the two calls below
 * are the whole of its lifecycle and they are deliberately asymmetric:
 *
 * - **Failing** — {@link raiseStanding} announces the arrival to the periphery
 *   (a desktop banner) and starts the escalation clock, which is what reaches a
 *   phone when nobody signs in. Nothing is stored, because the watch already
 *   answers "is this credential still dead?" and a second copy of that answer in
 *   the inbox would go stale the moment somebody signed in.
 * - **Recovered** — {@link resolveStanding} disarms that clock, retires the
 *   banner, and writes the one history row a standing kind ever writes.
 *   `cleared` is its outcome for the same reason `session.error` uses it: the
 *   condition ended without anybody answering a prompt. The row lands already
 *   read, so a sign-in somebody just fixed does not also light the bell.
 *
 * Both carry the episode's own `since`, exactly as the watch stamped it, so the
 * key the ladder armed under is the key the resolution disarms.
 *
 * ## Why there is no "the write failed, un-latch it" path any more
 *
 * There was one under DOR-1654, because the watch claims its episode BEFORE the
 * sink runs and the sink then wrote a row that could fail — leaving a runtime
 * silent for an hour on the strength of a notification that never happened. A
 * standing arrival writes nothing, so there is no write to fail; and the episode
 * is now released by the RESOLUTION rather than by a clock, which is the
 * stronger property: a credential fixed at 3.10 and dead again at 3.30 is heard
 * at 3.30, where the old hour-long window would have stayed quiet until 4.00.
 * The watch's own guard covers the remaining case by not claiming an episode at
 * all when no sink is installed to hear it.
 *
 * Installed at boot beside the other emitters, in `index.ts`.
 *
 * @module services/notifications/emitters/runtime-signin
 */
import { setRuntimeSigninSink } from '../../observability/index.js';
import { resolveStanding } from '../notification-service.js';
import { raiseStanding } from '../standing-events.js';

/**
 * Say something when a runtime's sign-in stops working, and stop saying it when
 * it works again.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
  setRuntimeSigninSink(({ runtime, edge, since }) => {
    if (edge === 'failing') {
      raiseStanding('signin.required', { runtime, since });
      return;
    }
    void resolveStanding('signin.required', { runtime, since }, { outcome: 'cleared' });
  });
  return () => setRuntimeSigninSink(null);
}
