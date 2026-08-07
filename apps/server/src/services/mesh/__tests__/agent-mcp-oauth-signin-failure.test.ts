/**
 * What happens to the sign-in flow a failed `mcp.signin` already minted (DOR-986).
 *
 * `startSignin` registers its `state` with the flow store BEFORE driving the SDK,
 * so a sign-in that dies during discovery leaves an entry behind that no caller
 * ever learns the id of — the throw replaces the return value. Left `pending`,
 * that `state` stays claimable for the full flow TTL, and anything that turns up
 * at the loopback callback carrying it can still complete a sign-in the operator
 * was never shown a link for. It has to be dropped.
 *
 * That is only observable if the test knows the state, and nothing hands it out —
 * so this file (and only this file) pins `randomBytes` to a fixed value. It stays
 * separate from the main service suite for exactly that reason: a constant state
 * would make two sign-ins in one suite collide.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    // Size-respecting, so the secret store's IV and host key stay valid; the
    // SDK's PKCE verifier comes from webcrypto and is untouched.
    randomBytes: (size: number) => Buffer.alloc(size, 7),
  };
});

const { AgentMcpOAuthService } = await import('../agent-mcp-oauth-service.js');

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const SERVER_URL = 'https://mcp.test.local/mcp';
const CALLBACK_BASE = 'http://127.0.0.1:4242';
const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

/** The `state` `startSignin` mints once `randomBytes` is pinned. */
const MINTED_STATE = Buffer.alloc(16, 7).toString('hex');

const inertScheduler = {
  set: (): ReturnType<typeof setTimeout> => 0 as unknown as ReturnType<typeof setTimeout>,
  clear: (): void => {},
};

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('AgentMcpOAuthService.startSignin — when the sign-in never gets off the ground', () => {
  it('drops the flow it minted, so that state cannot be redeemed afterwards', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    // The server is unreachable, so `auth()` throws during discovery — after the
    // flow was registered and before any link exists.
    const offline: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: offline,
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
    });

    await expect(oauth.startSignin(TARGET)).rejects.toThrow();

    // Someone turns up at the callback with the state that sign-in minted.
    const replayed = await oauth.handleCallback({ state: MINTED_STATE, code: 'a-code' });

    // Replacing `flows.drop(state)` with `markFailed` (or nothing) leaves the flow
    // registered, so the callback finds its target and runs the exchange — the
    // error then reads "Sign-in failed. Please try again." and this reddens.
    expect(replayed).toEqual({
      connected: false,
      error: 'This sign-in link expired. Please start again.',
    });
    expect(oauth.pollSignin(MINTED_STATE)).toEqual({
      status: 'failed',
      error: 'This sign-in link expired. Please start again.',
    });
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
  });
});
