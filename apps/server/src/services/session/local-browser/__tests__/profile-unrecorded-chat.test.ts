/**
 * A chat started in an agent's folder from the command line records no agent,
 * for good (DOR-5038). Its agent's browser profiles go by the one resolver in
 * `session-agent`: the agent whose home its server-held folder is, failing
 * closed. A real chat, bound through the registry's own write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  chatFactsOf,
  sessionAgentById,
  setSessionAgentSources,
} from '../../../core/agent-identity/session-agent.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  createLocalBrowserProfileAccess,
  createLocalBrowserProfileProof,
} from '../profile-access.js';

const JUNO = '/agents/juno';
const RIO = '/agents/rio';
const IDS: Record<string, string> = { [JUNO]: 'juno', [RIO]: 'rio' };

describe('a named browser profile for a chat that recorded no agent', () => {
  let db: Db;
  let live: Record<string, string>;
  /** Juno's profile is bound to Juno's home; nothing else is bound. */
  const profiles = {
    isBound: (profile: string, agent: string, folder: string) =>
      profile === 'juno-profile' && agent === 'juno' && folder === JUNO,
  };
  const binding = {
    profiles,
    agentIdAtPath: (agentPath: string) => IDS[agentPath],
    realFolder: (agentPath: string) => agentPath,
  };
  const guardsOf = () => ({ protectedPaths: true, ownFolder: true });

  beforeEach(async () => {
    db = createTestDb();
    live = {};
    registerTestHomes([JUNO, RIO]);
    setSessionAgentSources({ db, liveCwd: (sessionId) => live[sessionId] });
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    registry.register(new FakeAgentRuntime('claude-code') as never);
    // The CLI's shape: a folder, no agent.
    await registry.persistSessionRuntime('cli', 'claude-code', { kind: 'interactive' });
    live.cli = JUNO;
  });

  afterEach(() => {
    setSessionAgentSources(undefined);
    clearTestHomes();
  });

  const access = () =>
    createLocalBrowserProfileAccess({
      ...binding,
      resolveSessionRuntime: async () => ({ type: 'claude-code', bound: true }),
      guardsOf,
      sessionAgent: sessionAgentById,
    });
  const proof = () =>
    createLocalBrowserProfileProof({
      ...binding,
      sessionFacts: (sessionId) => chatFactsOf(db, sessionId),
      guardsOf,
    });

  it('lets the chat use its folder’s agent’s own profile, and no other agent’s', async () => {
    await expect(access()('juno-profile', 'cli')).resolves.toBeUndefined();
    live.cli = RIO;
    await expect(access()('juno-profile', 'cli')).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
  });

  it('refuses a chat in a folder that is nobody’s, or whose folder is no longer known', async () => {
    live.cli = '/work/project';
    await expect(access()('juno-profile', 'cli')).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
    delete live.cli;
    await expect(access()('juno-profile', 'cli')).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
  });

  it('captures the pre-dispatch proof, and refuses it once the chat’s folder is lost', () => {
    const check = proof()('juno-profile', 'cli', 'juno');
    expect(check).not.toThrow();
    // A restart: the runtime no longer holds the chat, and nothing was stored.
    delete live.cli;
    expect(check).toThrow(expect.objectContaining({ code: 'profile_not_allowed' }));
  });

  it('refuses the proof once the chat stands in another agent’s home', () => {
    const check = proof()('juno-profile', 'cli', 'juno');
    live.cli = RIO;
    expect(check).toThrow(expect.objectContaining({ code: 'profile_not_allowed' }));
  });
});
