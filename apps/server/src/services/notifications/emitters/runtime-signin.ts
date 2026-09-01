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
import { setSigninFailureSink } from '../../observability/index.js';
import { notify } from '../notification-service.js';

/**
 * Say something when a runtime's sign-in stops working.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
  setSigninFailureSink((runtime) => {
    void notify('signin.required', { runtime });
  });
  return () => setSigninFailureSink(null);
}
