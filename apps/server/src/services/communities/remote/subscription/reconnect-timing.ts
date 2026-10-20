/**
 * How long a space subscription takes to come back, and how fresh a missed message must be to
 * still wake an agent once it does (DOR-2976).
 *
 * The two used to be set apart: a link that went quiet was noticed only after 50 seconds, while
 * a missed message woke an agent only if it was under 30 seconds old, so a mention sent early in
 * a silent drop stayed unanswered. The window is now derived from the worst time to come back,
 * so changing one of those bounds moves it too.
 *
 * @module services/communities/remote/subscription/reconnect-timing
 */
import {
  ADDRESS_LOOKUP_TIMEOUT_MS,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_IDLE_TIMEOUT_MS,
} from '../pinned-origin.js';

/**
 * How long a subscription waits after its stream ends before it opens the next one. It is also
 * how often the runtime re-checks which streams should run, so raising it widens the window too.
 */
export const SUBSCRIPTION_RETRY_MS = 5_000;

/** Room for the resumed messages to be imported. It does not cover clock skew (DOR-2979). */
const RECONNECT_MARGIN_MS = 10_000;

/**
 * How old a message a reconnecting stream missed may be and still wake an agent: the longest a
 * dead link can go unnoticed, the wait before reopening, the longest the space's address lookup
 * and its answer may take, and a margin. A message older than this was missed by a longer outage, and is kept as
 * history rather than answered late.
 */
export const RECONNECT_FRESH_MS =
  SSE_IDLE_TIMEOUT_MS +
  SUBSCRIPTION_RETRY_MS +
  ADDRESS_LOOKUP_TIMEOUT_MS +
  SSE_CONNECT_TIMEOUT_MS +
  RECONNECT_MARGIN_MS;
