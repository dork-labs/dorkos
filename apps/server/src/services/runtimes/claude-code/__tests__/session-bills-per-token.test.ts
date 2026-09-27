/**
 * Whether a Claude Code session bills per token (spec `claude-account-fleet`
 * §6 U): what its launch recorded, what the binary's session-init said, and
 * what a launch made now would do. A per-token session never shows its
 * folder's subscription windows as its usage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), renameSession: vi.fn() }));
/** The configured provider references (what `providers` in config.json holds). */
const config = vi.hoisted(() => ({ providers: {} as Record<string, string> }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'providers' ? config.providers : undefined) },
}));
/** The credential resolver: a prediction must never reach it. */
const resolve = vi.hoisted(() => vi.fn());
vi.mock('../../../core/credential-provider.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  credentialProvider: { resolve },
}));

import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import type { AgentSession } from '../agent-types.js';
import { mapSystemEvent } from '../sdk/event-mappers/system-event-mapper.js';
import { ANTHROPIC_PROVIDER_ID } from '../../../core/credential-env.js';
import {
  ANTHROPIC_PROVIDER,
  envBillsPerToken,
  keySourceBillsPerToken,
  predictLaunchBillsPerToken,
} from '../messaging/per-token-billing.js';

function stubSession(runtime: ClaudeCodeRuntime, session: Partial<AgentSession> | undefined) {
  const store = (runtime as unknown as { sessionStore: { findSession: () => unknown } })
    .sessionStore;
  vi.spyOn(store, 'findSession').mockReturnValue(session);
}

describe('ClaudeCodeRuntime.sessionBillsPerToken', () => {
  let runtime: ClaudeCodeRuntime;

  beforeEach(() => {
    config.providers = {};
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('never launched, with no key anywhere: on the subscription', async () => {
    stubSession(runtime, undefined);
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(false);
  });

  it('never launched, with a stored key reference: per token, and the key is never resolved', async () => {
    stubSession(runtime, undefined);
    config.providers = { [ANTHROPIC_PROVIDER_ID]: 'keychain:dorkos-anthropic' };
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("never launched, with a key inherited from the server's own environment: per token", async () => {
    stubSession(runtime, undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited');
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(true);
  });

  it('a subscription reading of its own wins over the prediction', async () => {
    stubSession(runtime, { lastSubscriptionUsage: { kind: 'subscription', utilization: 0.3 } });
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited');
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(false);
  });

  it('after a launch, what the launch recorded', async () => {
    stubSession(runtime, {
      launchedPerToken: true,
      lastSubscriptionUsage: { kind: 'subscription', utilization: 0.3 },
    });
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(true);
    stubSession(runtime, { launchedPerToken: false });
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited');
    await expect(runtime.sessionBillsPerToken('s1')).resolves.toBe(false);
  });
});

describe('per-token billing signals', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    config.providers = {};
  });

  it("reads the launch's final environment, whatever put the key there", () => {
    expect(envBillsPerToken({ ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(envBillsPerToken({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u' })).toBe(true);
    expect(envBillsPerToken({ ANTHROPIC_API_KEY: '', CLAUDE_CONFIG_DIR: '/h' })).toBe(false);
  });

  it('treats any key source but none or oauth as per token', () => {
    expect(keySourceBillsPerToken('none')).toBe(false);
    expect(keySourceBillsPerToken('oauth')).toBe(false);
    for (const source of ['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'org']) {
      expect(keySourceBillsPerToken(source)).toBe(true);
    }
  });

  it('reads the same provider key the launch resolves a stored key from', () => {
    expect(ANTHROPIC_PROVIDER).toBe(ANTHROPIC_PROVIDER_ID);
  });

  it('predicts from presence alone, and per token on any signal', () => {
    const none = { keyReferenceConfigured: false, creditsOn: false, inheritedKey: false };
    expect(predictLaunchBillsPerToken(none)).toBe(false);
    expect(predictLaunchBillsPerToken({ ...none, keyReferenceConfigured: true })).toBe(true);
    expect(predictLaunchBillsPerToken({ ...none, creditsOn: true })).toBe(true);
    expect(predictLaunchBillsPerToken({ ...none, inheritedKey: true })).toBe(true);
  });

  it('predicts per token from an inherited key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited');
    expect(predictLaunchBillsPerToken()).toBe(true);
  });

  it("the binary's apiKeySource on init overrides the launch's guess", async () => {
    const session = { launchedPerToken: false, hasStarted: false } as AgentSession;
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-1',
      apiKeySource: 'ANTHROPIC_API_KEY',
    } as unknown as SDKMessage;
    for await (const _ of mapSystemEvent(init, session, 's1', {} as never)) {
      // drain
    }
    expect(session.launchedPerToken).toBe(true);

    const oauth = { ...init, apiKeySource: 'oauth' } as unknown as SDKMessage;
    for await (const _ of mapSystemEvent(oauth, session, 's1', {} as never)) {
      // drain
    }
    expect(session.launchedPerToken).toBe(false);
  });
});
