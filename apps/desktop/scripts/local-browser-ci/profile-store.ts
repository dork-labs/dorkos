/** Signed, throwaway profile records for native witnesses that cannot load Node's SQLite ABI. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { LocalBrowserProfile } from '@dorkos/shared/local-browser';
import type { LocalBrowserProfileStore } from '../../../server/src/services/session/local-browser/profile-store.js';

type Profile = Omit<LocalBrowserProfile, 'agentIds'>;
type Binding = { profileId: string; agentId: string; createdAt: string; signature: string };

/** Injectable records let the contract test corrupt stored data, rather than mock verification. */
export interface CiProfileRecords {
  profiles: Map<string, Profile>;
  bindings: Map<string, Binding>;
}

/** Same signed payload as the production profile store, with no database or saved data. */
export function createCiProfileStore(
  key: Buffer,
  revoked: (profileId: string, agentId?: string) => void,
  records: CiProfileRecords = { profiles: new Map(), bindings: new Map() }
): LocalBrowserProfileStore {
  if (process.env.CI !== 'true') throw new Error('The browser profile fixture is CI-only.');
  const signingKey = Buffer.from(key);
  const bindingId = (profileId: string, agentId: string) => JSON.stringify([profileId, agentId]);
  const signature = (profileId: string, agentId: string, agentFolder: string, createdAt: string) =>
    createHmac('sha256', signingKey)
      .update(
        JSON.stringify([
          'dorkos.browser-profile-binding.v1',
          profileId,
          agentId,
          agentFolder,
          createdAt,
        ])
      )
      .digest('hex');
  const profile = (row: Profile): LocalBrowserProfile => ({
    ...row,
    agentIds: [...records.bindings.values()]
      .filter((binding) => binding.profileId === row.id)
      .map((binding) => binding.agentId),
  });
  const ensure = (id: string, label: string) => {
    if (!records.profiles.has(id))
      records.profiles.set(id, { id, label, createdAt: new Date().toISOString() });
    return profile(records.profiles.get(id)!);
  };
  return {
    list: () => [...records.profiles.values()].map(profile),
    get(id) {
      const row = records.profiles.get(id);
      return row && profile(row);
    },
    create: (label) => ensure(randomUUID(), label),
    ensure,
    isBound(profileId, agentId, agentFolder) {
      const row = records.bindings.get(bindingId(profileId, agentId));
      if (!row || row.profileId !== profileId || row.agentId !== agentId) return false;
      const actual = Buffer.from(row.signature);
      const expected = Buffer.from(signature(profileId, agentId, agentFolder, row.createdAt));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    bind(profileId, agentId, agentFolder) {
      if (!records.profiles.has(profileId)) throw new Error('The fixture profile does not exist.');
      const createdAt = new Date().toISOString();
      records.bindings.set(bindingId(profileId, agentId), {
        profileId,
        agentId,
        createdAt,
        signature: signature(profileId, agentId, agentFolder, createdAt),
      });
    },
    unbind(profileId, agentId) {
      records.bindings.delete(bindingId(profileId, agentId));
      revoked(profileId, agentId);
    },
    remove(profileId) {
      for (const [id, row] of records.bindings)
        if (row.profileId === profileId) records.bindings.delete(id);
      records.profiles.delete(profileId);
      revoked(profileId);
    },
  };
}
