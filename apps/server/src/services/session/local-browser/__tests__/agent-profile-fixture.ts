import { createTestDb } from '@dorkos/test-utils/db';
import { leaseFixture } from './page-leases-fixture.js';
import { createAgentBrowserProfiles } from '../agent-profiles/agent-profiles.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';
import {
  createLocalBrowserProfileAccess,
  createLocalBrowserProfileProof,
} from '../profile-access.js';

type PageLeaseFixture = Awaited<ReturnType<typeof leaseFixture>>;
type ProfileLeaseFixture = PageLeaseFixture & {
  profiles: ReturnType<typeof createLocalBrowserProfileStore>;
  facts: ReturnType<typeof createProfileFacts>;
  selection: ReturnType<typeof createAgentBrowserProfiles>;
  personOpen: (
    sessionId?: string,
    profileId?: string
  ) => ReturnType<PageLeaseFixture['service']['openForPerson']>;
};

function createProfileFacts() {
  return new Map([
    ['atlas', { runtime: 'test', agentPath: '/agents/atlas' }],
    ['atlas-two', { runtime: 'test', agentPath: '/agents/atlas' }],
    ['bolt', { runtime: 'test', agentPath: '/agents/bolt' }],
  ]);
}

/** Real profile records, birth proofs, service and capability projection over fake Chrome. */
export async function profileLeaseFixture(): Promise<ProfileLeaseFixture> {
  const f = await leaseFixture();
  const facts = createProfileFacts();
  const profiles = createLocalBrowserProfileStore(
    createTestDb(),
    () => Buffer.alloc(32, 2),
    (profile, agent) => {
      void f.service.revokeProfileAccess(profile, agent);
    }
  );
  const deps = {
    profiles,
    resolveSessionRuntime: async (id: string) => ({
      type: facts.get(id)?.runtime ?? '',
      bound: facts.has(id),
    }),
    guardsOf: () => ({ protectedPaths: true as const }),
    getSessionAgentPath: async (id: string) => facts.get(id)?.agentPath ?? null,
    agentIdAtPath: (folder: string) => folder.split('/').at(-1),
    realFolder: (folder: string) => folder,
    agentName: (id: string) => id,
  };
  const selection = createAgentBrowserProfiles(deps);
  f.service.useSessionAgentLookup(async (id) => {
    const folder = facts.get(id)?.agentPath;
    return folder ? deps.agentIdAtPath(folder) : undefined;
  });
  f.service.useProfileSelection(selection.select, selection.initialize);
  f.service.useProfileAccess(
    createLocalBrowserProfileAccess(deps),
    (id) => !!profiles.get(id),
    createLocalBrowserProfileProof({ ...deps, sessionFacts: (id) => facts.get(id) })
  );
  return {
    ...f,
    profiles,
    facts,
    selection,
    personOpen: (sessionId?: string, profileId?: string) =>
      f.service.openForPerson({ mode: 'embedded', sessionId, profileId }),
  };
}
