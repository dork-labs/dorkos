/** Invented CI identity with real profile selection, signed bindings and birth proofs. */
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createDb, runMigrations } from '@dorkos/db';
import { LocalBrowserService } from '../../../server/src/services/session/local-browser/service.js';
import type { LocalBrowserBackend } from '../../../server/src/services/session/local-browser/playwright-backend.js';
import { createAgentBrowserProfiles } from '../../../server/src/services/session/local-browser/agent-profiles/agent-profiles.js';
import { createLocalBrowserProfileStore } from '../../../server/src/services/session/local-browser/profile-store.js';
import {
  createLocalBrowserProfileAccess,
  createLocalBrowserProfileProof,
} from '../../../server/src/services/session/local-browser/profile-access.js';

export const PUBLIC_CHROME_CHAT = 'made-up-ci-browser';
const AGENT = 'made-up-ci-agent';

/** No owner database, real agent folder, saved sign-ins or production runtime is used. */
export async function createPublicChromeBrowser(directory: string, backend: LocalBrowserBackend) {
  if (process.env.CI !== 'true') throw new Error('The public Chrome fixture is CI-only.');
  const folder = path.join(directory, 'agents', AGENT);
  await mkdir(folder, { recursive: true });
  const realFolder = await realpath(folder);
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    const browser = new LocalBrowserService(directory, undefined, backend);
    // This key signs only throwaway in-memory fixture records, never saved user data.
    const profiles = createLocalBrowserProfileStore(
      db,
      () => Buffer.alloc(32, 7),
      (id, agent) => {
        void browser.revokeProfileAccess(id, agent);
      }
    );
    const facts = (id: string) =>
      id === PUBLIC_CHROME_CHAT ? { runtime: 'test', agentPath: folder } : undefined;
    const deps = {
      profiles,
      resolveSessionRuntime: async (id: string) => ({
        type: facts(id)?.runtime ?? '',
        bound: !!facts(id),
      }),
      guardsOf: (type: string) => (type === 'test' ? { protectedPaths: true as const } : undefined),
      getSessionAgentPath: async (id: string) => facts(id)?.agentPath ?? null,
      agentIdAtPath: (candidate: string) => (candidate === folder ? AGENT : undefined),
      realFolder: (candidate: string) => (candidate === folder ? realFolder : undefined),
      agentName: (id: string) => (id === AGENT ? 'Made-up CI agent' : undefined),
    };
    const selection = createAgentBrowserProfiles(deps);
    browser.useProfileSelection(selection.select, selection.initialize);
    browser.useSessionAgentLookup(async (id) => {
      const agentPath = await deps.getSessionAgentPath(id);
      return agentPath ? deps.agentIdAtPath(agentPath) : undefined;
    });
    browser.useProfileAccess(
      createLocalBrowserProfileAccess(deps),
      (id) => !!profiles.get(id),
      createLocalBrowserProfileProof({ ...deps, sessionFacts: facts })
    );
    return {
      browser,
      profiles,
      async close() {
        try {
          await browser.closeAll();
        } finally {
          db.$client.close();
        }
      },
    };
  } catch (error) {
    db.$client.close();
    throw error;
  }
}
