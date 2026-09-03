/**
 * Turning whatever ngrok said into a sentence a person can act on.
 *
 * Lives with the tunnel entity rather than inside the Remote Access dialog
 * (DOR-1743): the Control Center's row shows the same sentence in one line, and
 * the dialog shows it in full. Two copies of this map would be two vocabularies
 * for the same failure.
 *
 * @module entities/tunnel/lib/tunnel-failure
 */

/** Map common ngrok errors to actionable messages. */
export function friendlyErrorMessage(raw: string): string {
  if (/auth|token|ERR_NGROK_105/i.test(raw)) {
    return 'Check your auth token at dashboard.ngrok.com';
  }
  // Three spellings, because the pattern used to be `/timeout|ETIMEDOUT/i` and
  // the message the dialog sees MOST often says "timed out" — two words. The
  // transport writes "Request timed out after 30s", so the one timeout this
  // panel is now guaranteed to render was the one spelling that fell straight
  // through to the raw text (DOR-1739).
  //
  // And not "check your network": that timeout is a request to a DorkOS server
  // usually running on this very machine, so blaming the network was wrong more
  // often than it was right. "Took too long" is true of that and of ngrok's own
  // ETIMEDOUT, without guessing which happened.
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) {
    return 'The tunnel took too long to respond. Try again.';
  }
  if (/limit|ERR_NGROK_108/i.test(raw)) {
    return 'Tunnel limit reached. Free ngrok accounts allow one active tunnel.';
  }
  if (/DNS|NXDOMAIN|ERR_NGROK_332/i.test(raw)) {
    return 'DNS resolution failed. Check your domain configuration.';
  }
  if (/gateway|502|ERR_NGROK_3200/i.test(raw)) {
    return 'Gateway error. The tunnel endpoint is unreachable.';
  }
  if (/upgrade|ERR_NGROK_120/i.test(raw)) {
    return 'Feature requires a paid ngrok plan.';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "Couldn't reach your DorkOS server. Make sure it's running.";
  }
  return raw;
}
