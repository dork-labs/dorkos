/**
 * Turns a dead runtime sign-in into something the operator actually sees
 * (DOR-1654).
 *
 * The noticing happens in `services/observability/runtime-signin-watch.ts`, wrapped
 * around every runtime at the one registration seam every turn passes through —
 * the interactive composer, a room reply, a scheduled run and an agent-to-agent
 * relay delivery alike. That module deliberately says nothing itself, so
 * `runtime-registry.ts` does not have to import the notification pipeline (and
 * the relay channel, and the store) behind it. This is the other half: what to
 * say, and it is the only half that knows about notifications at all.
 *
 * Installed at boot beside the other emitters, in `index.ts`.
 *
 * @module services/notifications/emitters/runtime-signin
 */
import { releaseSigninLatch, setSigninFailureSink } from '../../observability/index.js';
import { notify } from '../notification-service.js';

/**
 * Say something when a runtime's sign-in stops working.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
  setSigninFailureSink((runtime) => {
    void notify('signin.required', { runtime }).then((result) => {
      // **Nothing stored and not a duplicate means the write did not happen.**
      // `notify()` never throws — it swallows a store failure and answers
      // `{ notification: null, deduped: false }` — and the watch has already
      // claimed its latch by now, so without this the runtime would go quiet
      // for an hour on the strength of a row that does not exist. Releasing
      // hands the next failing turn another go.
      //
      // `deduped: true` is the opposite case and must NOT release: something
      // was said recently, which is exactly when staying quiet is right. The
      // relay-refusal branch that also answers `null` cannot arise here — this
      // kind declares `relay: 'never'`.
      if (!result.notification && !result.deduped) releaseSigninLatch(runtime);
    });
  });
  return () => setSigninFailureSink(null);
}
