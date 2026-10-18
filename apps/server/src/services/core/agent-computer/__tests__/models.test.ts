/**
 * How an agent computer pays for models (DOR-2940 part 9): OpenCode on DorkOS
 * credits only, with a token the computer mints with its own instance key
 * through the same loop a person's computer uses, renewed before it expires,
 * held back for fifteen minutes after a refusal, and never anything else.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Problem } from '@dork-labs/cloud-api';
import { CloudApiProblemError } from '@dork-labs/cloud-api/client';
import everyFormat from '@dork-labs/cloud-api/fixtures/v1/inference/token-every-format.json' with { type: 'json' };
import modelsFixture from '@dork-labs/cloud-api/fixtures/v1/inference/models.json' with { type: 'json' };

type Role = 'computer' | 'hub' | 'agent-computer';
const state = vi.hoisted(() => ({
  role: 'agent-computer' as Role,
  /** Bearer tokens a `/v1` client was built with, in order. */
  clientsFor: [] as string[],
  /** Mint request bodies, in order. */
  mints: [] as unknown[],
  /** What the next mints answer: a token, a refusal status, or an outage. */
  answer: 'token' as 'token' | 403 | 503,
  expiresInMs: 60 * 60_000,
  personLinkCaptured: 0,
}));

vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => state.role }));
vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 4242 } }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    // A person's account link and a Runs on choice of their own sign-in: the
    // agent computer must ignore both.
    get: (key: string) =>
      key === 'cloud'
        ? { instanceToken: 'person-link-token', credits: { defaults: { opencode: 'runtime' } } }
        : undefined,
    onChange: () => () => {},
  },
}));

/** A `/v1` client that answers the session, the mint and the model list. */
function fakeClient(bearer: string) {
  state.clientsFor.push(bearer);
  return {
    get: async (route: string) => {
      if (route === '/v1/session') {
        return { authenticated: true, instanceId: 'computer-instance-1', scopes: [] };
      }
      if (route === '/v1/inference/models') return modelsFixture;
      throw new Error(`unexpected GET ${route}`);
    },
    post: async (route: string, _schema: unknown, init: { body: unknown }) => {
      if (route !== '/v1/inference/tokens') throw new Error(`unexpected POST ${route}`);
      state.mints.push(init.body);
      if (state.answer === 403) {
        throw new CloudApiProblemError({
          code: 'forbidden',
          title: 'No',
          status: 403,
        } as unknown as Problem);
      }
      if (state.answer === 503) throw new Error('503 Service Unavailable');
      return {
        ...everyFormat,
        tokenId: `it_${state.mints.length}`,
        token: `minted-${state.mints.length}`,
        expiresAt: new Date(Date.now() + state.expiresInMs).toISOString(),
      };
    },
  };
}

vi.mock('../../cloud/v1-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../cloud/v1-client.js')>();
  return {
    ...real,
    createCloudV1ClientFor: (token: string) => fakeClient(token),
    isCloudLinked: () => true,
    readCloudInstanceToken: () => 'person-link-token',
    captureCloudV1Context: () => {
      state.personLinkCaptured += 1;
      return { client: fakeClient('person-link-token'), isCurrent: () => true };
    },
  };
});

const { __setAgentComputerInstanceKeyForTests, agentComputerInstanceKey } =
  await import('../instance-key.js');
const { AGENT_COMPUTER_MODELS_REFUSAL, AGENT_COMPUTER_REFUSAL_HOLD_MS } =
  await import('../models.js');
const {
  __setCreditsStateForTests,
  heldCreditsToken,
  noteCreditsTokenRefused,
  resolveCreditsLaunch,
  startCreditsLifecycle,
  stopCreditsLifecycle,
} = await import('../../cloud/credits-inference.js');
const { CreditsUnavailableError } = await import('../../cloud/credits-protocols.js');
const { __resetCreditsModelsForTests } = await import('../../cloud/credits-models.js');
const { openCodeRunsOnCredits, openCodeCreditsEnv } =
  await import('../../../runtimes/opencode/credits-sidecar.js');
const { planOpenCodeSidecar, planOpenCodeTurn } =
  await import('../../../runtimes/opencode/credits-mode.js');
const { OPENCODE_CAPABILITIES } = await import('../../../runtimes/opencode/runtime-constants.js');

const COMPUTER_KEY = 'computer-key-0123456789';
let clock = Date.now();

beforeEach(() => {
  state.role = 'agent-computer';
  state.clientsFor = [];
  state.mints = [];
  state.answer = 'token';
  state.expiresInMs = 60 * 60_000;
  state.personLinkCaptured = 0;
  clock = Date.now();
  __setAgentComputerInstanceKeyForTests(COMPUTER_KEY);
  __setCreditsStateForTests({ token: null, now: () => clock });
  __resetCreditsModelsForTests({ storePath: '/nonexistent/dorkos-test/credits-models.json' });
});

afterEach(() => {
  stopCreditsLifecycle();
  vi.useRealTimers();
  __setAgentComputerInstanceKeyForTests(undefined);
  __setCreditsStateForTests({ token: null });
});

/** Resolve a credits launch for OpenCode, as its turn does. */
function launchOpenCode() {
  return resolveCreditsLaunch(OPENCODE_CAPABILITIES, 'OpenCode', 1_000);
}

describe('the computer key', () => {
  it('is read only on an agent computer, and only when it is long enough', () => {
    expect(agentComputerInstanceKey()).toBe(COMPUTER_KEY);
    state.role = 'computer';
    expect(agentComputerInstanceKey()).toBeNull();
    state.role = 'hub';
    expect(agentComputerInstanceKey()).toBeNull();
    state.role = 'agent-computer';
    __setAgentComputerInstanceKeyForTests('too-short');
    expect(agentComputerInstanceKey()).toBeNull();
  });
});

describe('minting on an agent computer', () => {
  it('mints with the computer key, for its own instance, naming no agent', async () => {
    const launch = await launchOpenCode();
    expect(launch.token).toBe('minted-1');
    expect(launch.baseUrl).toBe(everyFormat.endpoints.openaiChat);
    expect(state.clientsFor).toEqual([COMPUTER_KEY]);
    expect(state.mints).toEqual([{ instanceId: 'computer-instance-1' }]);
    // The person's account link is never even looked at.
    expect(state.personLinkCaptured).toBe(0);
  });

  it('renews the token before it expires', async () => {
    vi.useFakeTimers();
    clock = Date.now();
    __setCreditsStateForTests({ token: null });
    startCreditsLifecycle();
    await vi.waitFor(() => expect(heldCreditsToken()?.token).toBe('minted-1'));
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    expect(heldCreditsToken()?.token).toBe('minted-2');
    expect(state.clientsFor.every((bearer) => bearer === COMPUTER_KEY)).toBe(true);
  });

  it('refuses a turn with no key, asking nobody, in its own sentence', async () => {
    __setAgentComputerInstanceKeyForTests(undefined);
    const refused = launchOpenCode();
    await expect(refused).rejects.toBeInstanceOf(CreditsUnavailableError);
    await expect(refused).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    expect(state.clientsFor).toEqual([]);
    expect(state.personLinkCaptured).toBe(0);
  });

  it('refuses a turn when the mint is refused, and asks again only after the hold', async () => {
    state.answer = 403;
    await expect(launchOpenCode()).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    expect(state.mints).toHaveLength(1);

    // Inside the hold, a turn is refused with no request at all.
    state.answer = 'token';
    clock += AGENT_COMPUTER_REFUSAL_HOLD_MS - 1_000;
    await expect(launchOpenCode()).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    expect(state.mints).toHaveLength(1);

    clock += 2_000;
    await expect(launchOpenCode()).resolves.toMatchObject({ token: 'minted-2' });
  });

  it('holds nothing after an outage, which says nothing about the account', async () => {
    state.answer = 503;
    await expect(launchOpenCode()).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    state.answer = 'token';
    await expect(launchOpenCode()).resolves.toMatchObject({ token: 'minted-2' });
  });

  it('drops a token the endpoint refused, and holds new ones for fifteen minutes', async () => {
    const first = await launchOpenCode();
    noteCreditsTokenRefused(first.tokenId);
    expect(heldCreditsToken()).toBeNull();
    await expect(launchOpenCode()).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    expect(state.mints).toHaveLength(1);
    clock += AGENT_COMPUTER_REFUSAL_HOLD_MS;
    await expect(launchOpenCode()).resolves.toMatchObject({ token: 'minted-2' });
  });

  it('changes nothing on a person`s computer when the endpoint refuses a token', async () => {
    state.role = 'computer';
    const first = await launchOpenCode();
    noteCreditsTokenRefused(first.tokenId);
    expect(heldCreditsToken()?.token).toBe(first.token);
    // A person's computer still mints under its account link.
    expect(state.personLinkCaptured).toBe(1);
  });
});

describe('OpenCode on an agent computer', () => {
  it('always runs on credits, whatever Runs on says', () => {
    expect(openCodeRunsOnCredits()).toBe(true);
    state.role = 'computer';
    expect(openCodeRunsOnCredits()).toBe(false);
  });

  it('refuses a turn with no token rather than run on its own providers', async () => {
    __setAgentComputerInstanceKeyForTests(undefined);
    await expect(planOpenCodeTurn()).rejects.toThrow(AGENT_COMPUTER_MODELS_REFUSAL);
    const sidecar = await planOpenCodeSidecar();
    expect(sidecar.mode).toBe('credits');
    expect(sidecar.models).toEqual([]);
  });

  it('plans a credits turn on the models served in its format', async () => {
    const plan = await planOpenCodeTurn();
    expect(plan.mode).toBe('credits');
    expect(plan.models.map((model) => model.id)).toEqual(['md_opaque_0002']);
  });

  it('hands the sidecar no other credential', () => {
    const env = openCodeCreditsEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'a',
      OPENROUTER_API_KEY: 'o',
      OPENAI_API_KEY: 'p',
      DORKOS_AGENT_COMPUTER_INSTANCE_KEY: COMPUTER_KEY,
      DORKOS_CREDITS_TOKEN_ABC: 't',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
