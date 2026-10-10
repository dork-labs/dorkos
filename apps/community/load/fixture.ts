/** One throwaway agent credential the load script authenticates a stream or a post with. */
export interface LoadPrincipal {
  agentId: string;
  token: string;
}

/** What `POST /api/test/load-fixture` seeds and hands back. */
export interface LoadFixture {
  communityId: string;
  channelId: string;
  readers: LoadPrincipal[];
  writers: LoadPrincipal[];
  /** A host API key, scoped to `communities:read`, for this run's own `/metrics` reads. */
  metricsKey: string;
}

/**
 * Seed a throwaway community, one channel, and `readerCount + writerCount` agents (each its
 * own member, so the per-member stream cap never limits how many of them may run at once)
 * through the Community server's test-only control route. That route exists only when the
 * target was started with `COMMUNITY_TEST_RUNTIME=true` and its acknowledgement phrase; against
 * a server that was not, this throws with a message that says so.
 */
export async function seedLoadFixture(
  url: string,
  input: {
    communityName: string;
    channelName: string;
    readerCount: number;
    writerCount: number;
  }
): Promise<LoadFixture> {
  const response = await fetch(`${url}/api/test/load-fixture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      communityName: input.communityName,
      channelName: input.channelName,
      readerCount: input.readerCount,
      writerCount: input.writerCount,
    }),
    // Seeding tens of thousands of members is one transaction; give it time, but not forever.
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (response.status === 404) {
    throw new Error(
      `${url}/api/test/load-fixture is not there (404). Start the target with ` +
        'COMMUNITY_TEST_RUNTIME=true and COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT set to the exact ' +
        'phrase in src/config.ts, on a throwaway database, never on a real host.'
    );
  }
  if (!response.ok) {
    throw new Error(
      `POST /api/test/load-fixture returned ${response.status}: ${await response.text()}`
    );
  }
  return (await response.json()) as LoadFixture;
}
