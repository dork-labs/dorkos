/**
 * Tells a person about every turn DorkOS credits refused (ADR 261001-000811),
 * whoever started it.
 *
 * A chat draws the refusal as a card with its ways on. Nothing else did: a
 * scheduled task, a relay delivery and a room turn each consume their own
 * stream, so a turn refused at 3am because credits were off, the computer was
 * signed out, or the folder has a sign-in of its own simply did nothing, and
 * nobody knew. The runtime-registry wrap (`observability/runtime-signin-watch.ts`)
 * sees every one of those turns; this installs what it says.
 *
 * One notification per runtime and reason an hour (the registry's dedupe), so
 * ten tasks refused for one reason are one thing to be told. "Open" goes to the
 * session that noticed, where the refused turn carries Retry, the own sign-in,
 * and "Don't use credits in this project".
 *
 * @module services/notifications/emitters/credits-refused
 */
import { setCreditsRefusedSink } from '../../observability/index.js';
import { notify } from '../notification-service.js';

/**
 * Start telling a person about refused credits turns.
 *
 * @returns A teardown that stops it.
 */
export function watchCreditsRefusals(): () => void {
  setCreditsRefusedSink(({ runtime, sessionId, message }) => {
    void notify('credits.refused', { runtime, sessionId, message });
  });
  return () => setCreditsRefusedSink(null);
}
