import { useSafeSearch } from '@/layers/shared/model';
import type { SessionSearch } from '@/router';

/**
 * Read session search params safely from any route — and any platform.
 *
 * Returns `{ session, dir, runtime, prompt, send, seed }` when on
 * `/_shell/session`, empty object otherwise. Routes through
 * {@link useSafeSearch}, so it never throws on a route mismatch
 * (`strict: false`) and degrades to an empty object in the router-less Obsidian
 * embed instead of crashing.
 *
 * **It is an allow-list, and that is the trap.** A param added to
 * `sessionSearchSchema` but not repeated here is silently dropped: the return
 * type is `Partial<SessionSearch>`, so a caller destructuring the missing field
 * type-checks perfectly and reads `undefined` forever. Adding a session param
 * means adding it in both places.
 */
export function useSessionSearch(): Partial<SessionSearch> {
  const search = useSafeSearch();
  return {
    session: typeof search.session === 'string' ? search.session : undefined,
    dir: typeof search.dir === 'string' ? search.dir : undefined,
    runtime: typeof search.runtime === 'string' ? search.runtime : undefined,
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    // Narrowed to the one literal that means anything. This value decides
    // whether a link may start a turn, so it is read as an exact opt-in here
    // too rather than trusting the route schema alone to have done it.
    send: search.send === '1' ? '1' : undefined,
    // Ask DorkBot's launch link (BC-48). Narrowed to the enumerated literal for
    // the same reason `send` is: this value decides what a turn is silently told
    // about the operator, so an address bar may not put arbitrary text there.
    seed: search.seed === 'dorkbot-help' ? 'dorkbot-help' : undefined,
  };
}
