import type { RemoteHandoff } from './config.js';
import type { CommunityServer } from './infra.js';

/**
 * Where the journey's community lives: two servers this run starts on its own
 * Postgres (local mode), or one community the live gate made and is holding
 * (remote mode), which this run must never start, stop or delete.
 *
 * @module community-two-desktop/target
 */

/** The communities one run talks to. */
export type CommunityTarget =
  | {
      mode: 'local';
      /** "Desktop Proof", where both people meet. */
      proof: CommunityServer;
      /** "Isolation Proof", which only A joins. */
      isolation: CommunityServer;
    }
  | { mode: 'remote'; handoff: RemoteHandoff };

/** What the run needs from its infrastructure to start a local target. */
export interface InfraStarter {
  startPostgres(): Promise<void>;
  startCommunity(name: string, extraEnv?: Record<string, string>): Promise<CommunityServer>;
}

/**
 * Bring up the run's communities. Remote mode builds no infrastructure at all:
 * `makeInfra` is never called, so no container, database or server can start.
 *
 * @param remote - The held community, or `null` for a local run.
 * @param makeInfra - Builds the infrastructure, only for a local run.
 */
export async function prepareTarget<I extends InfraStarter>(
  remote: RemoteHandoff | null,
  makeInfra: () => I
): Promise<{ target: CommunityTarget; infra: I | null }> {
  if (remote) return { target: { mode: 'remote', handoff: remote }, infra: null };
  const infra = makeInfra();
  await infra.startPostgres();
  const proof = await infra.startCommunity('proof', {
    // One active agent per member, so step 20 can prove the limit is enforced.
    COMMUNITY_AGENTS_PER_OWNER: '1',
  });
  const isolation = await infra.startCommunity('isolation');
  return { target: { mode: 'local', proof, isolation }, infra };
}
