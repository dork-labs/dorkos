import { useQuery } from '@tanstack/react-query';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { useTransport } from '@/layers/shared/model';
import { harnessKeys } from '../api/query-keys';

/**
 * Read the harness status that is already in the cache, and never ask for one.
 *
 * For the surface that wants the number without paying for it: the profile row
 * (Decision 28). `buildHarnessStatus` is three synchronous filesystem walks —
 * about 22 ms of blocked event loop — and the profile opens on every `/session`,
 * so firing this query there would spend that on every visit for a count nobody
 * asked to see. This hook subscribes to whatever {@link useHarnessStatus} has
 * already put under the same key and answers `undefined` until something does.
 *
 * **`enabled: false` is the whole mechanism.** The `queryFn` beside it is a real
 * fetch and would run without it; the flag is what makes this a reader rather
 * than a second caller. Silence before the page has been opened is the honest
 * middle state — `countValue(null)` draws no number rather than inventing a
 * zero — so "Skills" with nothing after it is correct, and "Skills 0" would be a
 * lie about an agent with thirty-one.
 *
 * @param projectPath - The agent's project directory, or `null` when the caller
 *   does not know one yet. A `null` path subscribes to a key nothing fills.
 */
export function useHarnessStatusCached(projectPath: string | null) {
  const transport = useTransport();
  return useQuery<HarnessStatusResponse>({
    queryKey: harnessKeys.status(projectPath),
    queryFn: () => transport.getHarnessStatus(projectPath ?? ''),
    enabled: false,
  });
}
