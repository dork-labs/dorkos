import { useSafeSearch } from '@/layers/shared/model';
import type { SessionSearch } from '@/router';

/**
 * Read session search params safely from any route — and any platform.
 *
 * Returns `{ session, dir, runtime, prompt }` when on `/_shell/session`, empty
 * object otherwise. Routes through {@link useSafeSearch}, so it never throws on
 * a route mismatch (`strict: false`) and degrades to an empty object in the
 * router-less Obsidian embed instead of crashing.
 */
export function useSessionSearch(): Partial<SessionSearch> {
  const search = useSafeSearch();
  return {
    session: typeof search.session === 'string' ? search.session : undefined,
    dir: typeof search.dir === 'string' ? search.dir : undefined,
    runtime: typeof search.runtime === 'string' ? search.runtime : undefined,
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
  };
}
