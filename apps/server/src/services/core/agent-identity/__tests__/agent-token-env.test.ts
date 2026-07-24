import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../agent-identity-service.js';
import { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from '../agent-token-env.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

describe('resolveAgentTokenEnv', () => {
  beforeEach(() => {
    resetAgentIdentityService();
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('mints a token and returns it as the spawn-env fragment', async () => {
    const service = initAgentIdentityService(createTestDb());

    const env = await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    expect(Object.keys(env)).toEqual([AGENT_TOKEN_ENV_VAR]);
    // The value handed to the spawned process is a real, resolvable identity.
    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);
    expect(identity).toMatchObject({ agentPath: AGENT_PATH, displayName: 'Researcher' });
  });

  it('mints a FRESH token per spawn without invalidating the previous one', async () => {
    const service = initAgentIdentityService(createTestDb());

    const first = await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');
    const second = await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    expect(first[AGENT_TOKEN_ENV_VAR]).not.toBe(second[AGENT_TOKEN_ENV_VAR]);
    // Concurrent sessions for one agent must both keep working.
    expect(await service.resolve(first[AGENT_TOKEN_ENV_VAR]!)).toBeDefined();
    expect(await service.resolve(second[AGENT_TOKEN_ENV_VAR]!)).toBeDefined();
  });

  it('falls back to the agent path when no display name is given', async () => {
    const service = initAgentIdentityService(createTestDb());

    const env = await resolveAgentTokenEnv(AGENT_PATH, '   ');

    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);
    expect(identity?.displayName).toBe(AGENT_PATH);
  });

  it('returns {} when the directory hosts no registered agent', async () => {
    initAgentIdentityService(createTestDb());

    expect(await resolveAgentTokenEnv(undefined, 'Researcher')).toEqual({});
  });

  it('returns {} when the service was never initialized', async () => {
    expect(await resolveAgentTokenEnv(AGENT_PATH, 'Researcher')).toEqual({});
  });

  it('returns {} instead of throwing when minting fails', async () => {
    const service = initAgentIdentityService(createTestDb());
    vi.spyOn(AgentIdentityService.prototype, 'mint').mockRejectedValueOnce(new Error('db down'));

    // A session that cannot be attributed must still spawn.
    await expect(resolveAgentTokenEnv(AGENT_PATH, 'Researcher')).resolves.toEqual({});
    expect(service).toBeDefined();
    vi.restoreAllMocks();
  });
});
