import { afterEach, expect, it, vi } from 'vitest';
import { createAgentBrowserProfiles } from '../../../server/src/services/session/local-browser/agent-profiles/agent-profiles.js';
import { createCiProfileStore, type CiProfileRecords } from '../local-browser-ci/profile-store.js';

const PROFILE = 'agent-made-up-ci-agent';
const AGENT = 'made-up-ci-agent';
const FOLDER = '/made-up/agent';
const input = { mode: 'new-window' as const, sessionId: 'known-chat' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function fixture(key = Buffer.alloc(32, 7)) {
  vi.stubEnv('CI', 'true');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'));
  const records: CiProfileRecords = { profiles: new Map(), bindings: new Map() };
  const revoked = vi.fn();
  const profiles = createCiProfileStore(key, revoked, records);
  const selection = createAgentBrowserProfiles({
    profiles,
    resolveSessionRuntime: async (id) => ({ type: 'test', bound: id === input.sessionId }),
    guardsOf: () => ({ protectedPaths: true }),
    getSessionAgentPath: async (id) => (id === input.sessionId ? FOLDER : null),
    agentIdAtPath: (folder) => (folder === FOLDER ? AGENT : undefined),
    realFolder: (folder) => (folder === FOLDER ? FOLDER : undefined),
    agentName: () => 'Made-up CI agent',
  });
  return { records, profiles, revoked, selection };
}

it('refuses the store outside CI', () => {
  vi.stubEnv('CI', 'false');
  expect(() => createCiProfileStore(Buffer.alloc(32, 7), () => undefined)).toThrow('CI-only');
});

it('uses the production binding payload, including its domain, ids, folder and timestamp', async () => {
  const f = fixture();
  await expect(f.selection.select(input)).rejects.toMatchObject({ code: 'profile_not_allowed' });
  expect(f.profiles.list()).toEqual([]);
  await f.selection.initialize(input);
  expect(f.profiles.isBound(PROFILE, AGENT, FOLDER)).toBe(true);
  expect(f.profiles.isBound(PROFILE, AGENT, '/foreign/folder')).toBe(false);
  expect(f.profiles.isBound(PROFILE, 'foreign-agent', FOLDER)).toBe(false);
  expect(f.profiles.isBound('foreign-profile', AGENT, FOLDER)).toBe(false);
  const record = [...f.records.bindings.values()][0]!;
  expect(record.createdAt).toBe('2026-11-20T00:00:00.000Z');
  expect(record.signature).toBe('320c5d6e8364472eeb8a307e2b40e1312761d6a7ffe7fd32e15b52aecc91a317');
  expect(f.profiles.get('default')?.agentIds).toEqual([]);
});

it.each([
  { signature: '0'.repeat(64) },
  { signature: 'short' },
  { signature: '' },
  { createdAt: '2026-11-21T00:00:00.000Z' },
  { profileId: 'foreign-profile' },
  { agentId: 'foreign-agent' },
])('refuses an agent after the stored binding is tampered: %j', async (change) => {
  const f = fixture();
  await f.selection.initialize(input);
  const [id, row] = [...f.records.bindings][0]!;
  f.records.bindings.set(id, { ...row, ...change });
  expect(f.profiles.isBound(PROFILE, AGENT, FOLDER)).toBe(false);
  await expect(f.selection.select(input)).rejects.toMatchObject({ code: 'profile_not_allowed' });
});

it('refuses a foreign signed record and synchronously revokes an unshared binding', async () => {
  const f = fixture();
  const foreign = fixture(Buffer.alloc(32, 8));
  await f.selection.initialize(input);
  await foreign.selection.initialize(input);
  const [id, original] = [...f.records.bindings][0]!;
  f.records.bindings.set(id, [...foreign.records.bindings.values()][0]!);
  await expect(f.selection.select(input)).rejects.toMatchObject({ code: 'profile_not_allowed' });
  f.records.bindings.set(id, original);
  f.profiles.unbind(PROFILE, AGENT);
  expect(f.revoked).toHaveBeenCalledWith(PROFILE, AGENT);
  await expect(f.selection.select(input)).rejects.toMatchObject({ code: 'profile_not_allowed' });
});
