import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../agent-identity-service.js';
import {
  resolveAgentTokenEnv,
  createInSessionContextResolver,
  AGENT_TOKEN_ENV_VAR,
} from '../agent-token-env.js';
import { logger } from '../../../../lib/logger.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

/** Every argument the logger mock has seen, flattened for substring scanning. */
function allLoggedText(): string {
  const mocked = logger as unknown as Record<string, { mock: { calls: unknown[][] } }>;
  return Object.values(mocked)
    .flatMap((fn) => fn.mock.calls)
    .map((call) => JSON.stringify(call))
    .join('\n');
}

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

  it('never writes the token into a log line', async () => {
    initAgentIdentityService(createTestDb());
    vi.clearAllMocks();

    const env = await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');
    const token = env[AGENT_TOKEN_ENV_VAR]!;

    // The token is a live credential: it must not reach logs, which ship to
    // files and error reporters.
    expect(token).toBeTruthy();
    expect(allLoggedText()).not.toContain(token);
  });

  it('logs the agent but no token material when minting fails', async () => {
    initAgentIdentityService(createTestDb());
    vi.clearAllMocks();
    vi.spyOn(AgentIdentityService.prototype, 'mint').mockRejectedValueOnce(
      new Error('SQLITE_BUSY: database is locked')
    );

    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    // The failure is debuggable (which agent, which error) without the log
    // ever being handed a credential — `mint` throws from the insert, before
    // any token is in this function's scope.
    const logged = allLoggedText();
    expect(logged).toContain(AGENT_PATH);
    expect(logged).toContain('SQLITE_BUSY');
    expect(logged).not.toMatch(/[0-9a-f]{32}/);
    vi.restoreAllMocks();
  });
});

describe('createInSessionContextResolver', () => {
  beforeEach(() => {
    resetAgentIdentityService();
  });

  afterEach(() => {
    resetAgentIdentityService();
    vi.restoreAllMocks();
  });

  it('resolves the identity of the agent whose session it is', async () => {
    initAgentIdentityService(createTestDb());
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    const context = await createInSessionContextResolver(AGENT_PATH)();

    expect(context?.identity).toMatchObject({
      agentPath: AGENT_PATH,
      displayName: 'Researcher',
      tierCeiling: 'destructive',
    });
  });

  it('memoizes so many tool calls in one session cost one lookup', async () => {
    initAgentIdentityService(createTestDb());
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');
    const spy = vi.spyOn(AgentIdentityService.prototype, 'describeAgent');

    const resolve = createInSessionContextResolver(AGENT_PATH);
    await Promise.all([resolve(), resolve(), resolve()]);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('resolves undefined when the session has no agent path', async () => {
    initAgentIdentityService(createTestDb());

    expect(await createInSessionContextResolver(undefined)()).toBeUndefined();
  });

  it('resolves undefined when the agent holds no live token', async () => {
    initAgentIdentityService(createTestDb());

    expect(await createInSessionContextResolver('/projects/never-minted')()).toBeUndefined();
  });

  it('resolves a REVOKED context after the agent is revoked, not an empty one', async () => {
    // Changed on purpose (DOR-486). An empty context reads as "unidentified" at
    // the capability gate, and an unidentified caller gets the widest tier
    // ceiling — so answering `undefined` here meant revoking a capped agent
    // mid-session WIDENED what its in-session tools could reach. The context now
    // names the agent and its state, and the gate caps it at `observe`.
    const service = initAgentIdentityService(createTestDb());
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');
    await service.revoke(AGENT_PATH);

    const context = await createInSessionContextResolver(AGENT_PATH)();

    expect(context?.identity).toMatchObject({ agentPath: AGENT_PATH, inactive: 'revoked' });
  });

  it('resolves undefined when the service was never initialized', async () => {
    expect(await createInSessionContextResolver(AGENT_PATH)()).toBeUndefined();
  });

  it('resolves undefined instead of throwing when the lookup fails', async () => {
    initAgentIdentityService(createTestDb());
    vi.spyOn(AgentIdentityService.prototype, 'describeAgent').mockRejectedValueOnce(
      new Error('db down')
    );

    // Attribution must never fail the agent's tool call.
    await expect(createInSessionContextResolver(AGENT_PATH)()).resolves.toBeUndefined();
  });
});
