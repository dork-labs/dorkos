/**
 * Can the BROWSER reach this dev server?
 *
 * The server has its own port probe (`POST /api/workbench/probe`), and it answers
 * a different question: whether something is listening on the machine running
 * DorkOS. Those two answers part company the moment a port is forwarded — a
 * cockpit reached through `docker run -p 4242:4242` or `ssh -L 4242:localhost:4242`
 * has the viewer typing `localhost` while `localhost` on the DorkOS side is a
 * different machine entirely. The server would say "yes, 5173 is listening", the
 * frame would load `http://localhost:5173/` on the viewer's machine, and Chrome
 * would render its own connection-refused page — which fires `load`, so even the
 * slow-preview banner stays quiet. A blank rectangle with nothing said about it,
 * which is the whole failure this phase exists to remove.
 *
 * So a decision about what the browser can load is made by the browser. A
 * `no-cors` request cannot read the response — it does not need to. Resolving at
 * all means something on the viewer's own machine answered.
 *
 * @module features/canvas/lib/probe-direct
 */

/**
 * How long to wait before giving up on a silent target.
 *
 * Short on purpose: this runs before every dev-server preview, and the case it
 * has to catch — a refused connection on the viewer's own machine — comes back
 * in tens of milliseconds (measured at ~62 ms), never in seconds. Nothing that
 * matters is decided by making this longer, because a target that is merely slow
 * is treated as alive rather than as absent. See {@link probeDirect}.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether the page's own browser can reach `url`.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 * - **Answered** — something is there. Reachable.
 * - **Rejected** — the connection was refused (or blocked). This is the
 *   forwarded-port case, and it is fast: a `docker -p` or `ssh -L` cockpit
 *   REFUSES a port with nothing behind it, it does not hang. Unreachable.
 * - **Silent past the deadline** — the target is thinking, not missing. A Next.js
 *   first request, a Vite mid-pre-bundle, a dev server that just restarted: all
 *   reachable, all capable of taking longer than this deadline to send a header.
 *   Calling those unreachable would demote a perfectly good dev server to the
 *   proxy path and hand the user the blank frame this whole change removes. So a
 *   timeout means **reachable**, the frame is mounted, and the browser's own
 *   10-second load deadline is what says something is wrong if nothing arrives.
 *
 * A blackholed port — forwarded but with nothing behind it, so it hangs instead
 * of refusing — lands in that last bucket and is framed. That is the honest
 * trade: it is rarer than a slow compile, and the load-deadline banner tells the
 * truth about it a few seconds later.
 *
 * @param url - The logical target URL, exactly as it would be framed.
 * @param fetchImpl - Injected for tests; defaults to the page's `fetch`.
 * @param timeoutMs - How long to wait before treating silence as "still thinking".
 * @returns True when something answered or is still thinking, false when refused.
 */
export async function probeDirect(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `no-cors` so a dev server that sends no CORS headers still answers instead
    // of failing the request; the opaque response is unreadable and irrelevant.
    // `no-store` so a server that has since stopped cannot be vouched for by a
    // cached answer.
    await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    // Our own deadline is the only thing that aborts this controller, so
    // `aborted` separates "still thinking" from "refused" without trusting the
    // shape of the rejection — a polyfill's abort error is not guaranteed to be
    // a DOMException named `AbortError`, and this decision is too load-bearing
    // to rest on that.
    return controller.signal.aborted;
  } finally {
    clearTimeout(timer);
  }
}
