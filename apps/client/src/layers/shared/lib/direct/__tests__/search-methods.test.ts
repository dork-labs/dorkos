/**
 * A window with no index refuses, and never answers emptily (DOR-1563, gates B
 * and C of the DOR-691 verify pass).
 *
 * **`{ results: [], warnings: [] }` is the one answer this must never give.** It
 * is indistinguishable from "nothing you ever said matches that", which would
 * tell somebody their history does not hold a sentence they know they wrote.
 * Every other surface in message search refuses rather than shrugs, and the
 * in-process transport is the one place where an unwired seam makes the wrong
 * answer easy to reach: `services.search` is optional, so a host that forgot it
 * still constructs.
 *
 * It also gives {@link SEARCH_INDEX_UNAVAILABLE} its only consumer outside the
 * module that declares it. A code exported for callers to branch on, with no
 * caller anywhere, is a promise nobody checked.
 *
 * @module shared/lib/direct/__tests__/search-methods
 */
import { describe, expect, it } from 'vitest';

import { createDirectSearchMethods, SEARCH_INDEX_UNAVAILABLE } from '../search-methods';
import type { DirectTransportServices } from '../services';

/** A host that wired everything except an index. */
const withoutIndex = {} as unknown as DirectTransportServices;

describe('a search in a window with no index', () => {
  it('rejects rather than resolving with an empty result list', async () => {
    const { search } = createDirectSearchMethods(withoutIndex);

    await expect(search({ q: 'scheduler' })).rejects.toThrow(
      'This window has no copy of your message history to search.'
    );
  });

  it('carries the code, the status and the body an HTTP refusal would', async () => {
    // The box above the transport renders whichever refusal it is handed and
    // never asks which window it is in, so this one has to arrive in the same
    // shape `fetchJSON` raises.
    const { search } = createDirectSearchMethods(withoutIndex);

    const thrown = await search({ q: 'scheduler' })
      .then(() => null)
      .catch((err: unknown) => err as Error & { code?: string; status?: number; body?: unknown });

    expect({ code: thrown?.code, status: thrown?.status }).toEqual({
      code: SEARCH_INDEX_UNAVAILABLE,
      status: 503,
    });
    expect(thrown?.body).toEqual({
      error: thrown?.message,
      code: SEARCH_INDEX_UNAVAILABLE,
    });
  });

  it('hands back exactly what a wired seam answered, once there is one', async () => {
    // The positive control: without it, "rejects" above would pass just as
    // loudly if this function rejected unconditionally.
    const { search } = createDirectSearchMethods({
      search: { search: () => ({ ok: true, response: { results: [], warnings: [] } }) },
    } as unknown as DirectTransportServices);

    await expect(search({ q: 'scheduler' })).resolves.toEqual({ results: [], warnings: [] });
  });
});
