import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, sessionNativeBindings } from '@dorkos/db';
import { toAccountUsage, type AccountUsage } from '@dorkos/shared/account-usage';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import {
  creditsClaudeRoot,
  isCreditsClaudeRoot,
} from '../../../runtimes/claude-code/credits-root.js';
import { claudeCodeFacts, setClaudeCodeFacts } from '../../resolution/claude-code-facts.js';
import { SessionLimitStore, setSessionLimitStore } from '../../fleet/session-limit-store.js';
import { chatUsagePauseOf } from '../sending/chat-usage-pause.js';
import {
  disposeProjector,
  getOrCreateProjector,
  rekeyProjector,
} from '../../session-state-projector.js';
import { linkSessionId, resetSessionKeys } from '../../resolution/session-key-registry.js';

const NOW = new Date('2026-11-20T07:00:00.000Z');
const RESET = '2026-11-21T07:00:00.000Z';
let perToken: boolean;
let root: string;
let usage: AccountUsage | null;
let limits: SessionLimitStore;
let billingCwd: string | undefined;

function recordLimit(resetsAt: string | null = RESET) {
  limits.upsert({
    sessionId: 'dm',
    scope: 'account',
    accountPath: root,
    limit: {
      accountId: 'full',
      window: 'seven_day',
      resetsAt,
      since: NOW.toISOString(),
      plan: { mode: 'ask' },
      scope: 'account',
      state: 'limited',
    },
  });
}

beforeEach(() => {
  // What the startup hands turn code (DOR-4928): which folder is the credits one.
  setClaudeCodeFacts({ ...claudeCodeFacts(), isCreditsRoot: isCreditsClaudeRoot });
  vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  perToken = false;
  root = '/accounts/full';
  billingCwd = undefined;
  const db = createTestDb();
  runtimeRegistry.setDb(db);
  const runtime = Object.assign(new FakeAgentRuntime('claude-code'), {
    getSessionAccount: () => undefined,
    accountRootForSession: async (_id: string, cwd: string) => {
      billingCwd = cwd;
      return root;
    },
    sessionBillsPerToken: async () => perToken,
  });
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(runtime);
  db.insert(sessionMetadata)
    .values({
      sessionId: 'dm',
      runtime: 'claude-code',
      agentPath: '/agents/demo',
      createdAt: NOW.toISOString(),
    })
    .run();
  db.insert(sessionNativeBindings)
    .values({
      sessionId: 'dm',
      runtime: 'claude-code',
      cwd: '/work/original-project',
      createdAt: NOW.toISOString(),
    })
    .run();
  limits = new SessionLimitStore(db);
  setSessionLimitStore(limits);
  usage = toAccountUsage(
    {
      v: 1,
      runtime: 'claude-code',
      accountId: 'full',
      updatedAt: NOW.toISOString(),
      windows: {
        seven_day: {
          usedPct: 100,
          resetsAt: RESET,
          status: null,
          observedAt: NOW.toISOString(),
          source: 'sdk_usage',
        },
      },
    },
    { accountId: 'full', path: root, label: 'Full', color: '#123456' },
    NOW
  );
  setAccountUsageStore({ peekByRoot: () => usage } as unknown as AccountUsageStore);
});

afterEach(() => {
  disposeProjector('dm');
  disposeProjector('canonical-dm');
  resetSessionKeys();
  vi.restoreAllMocks();
  setAccountUsageStore(undefined);
  setSessionLimitStore(undefined);
});

describe('live usage-pause notices', () => {
  it('detects a full ledger before a runtime rejection', async () => {
    await expect(chatUsagePauseOf('dm', '/work/demo')).resolves.toEqual({ resetsAt: RESET });
  });

  it('reads the durable project when the kept DM is cold', async () => {
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: RESET });
    expect(billingCwd).toBe('/work/original-project');
  });

  it('keeps a healthy chat available', async () => {
    usage!.state = 'ok';
    usage!.limit = null;
    await expect(chatUsagePauseOf('dm')).resolves.toBeNull();
  });

  it('finds a durable pause without a live projector or usage ledger', async () => {
    usage = null;
    recordLimit();
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: RESET });
  });

  it('finds a canonical durable pause after a rekeyed projector is evicted', async () => {
    usage = null;
    recordLimit();
    getOrCreateProjector('dm');
    rekeyProjector('dm', 'canonical-dm');
    linkSessionId('dm', 'canonical-dm');
    disposeProjector('canonical-dm');
    expect(limits.get('canonical-dm')).toBeDefined();
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: RESET });
  });

  it('ignores an expired durable pause once the account has room', async () => {
    usage!.state = 'ok';
    usage!.limit = null;
    recordLimit('2000-01-01T00:00:00.000Z');
    await expect(chatUsagePauseOf('dm')).resolves.toBeNull();
  });

  it('still reports a current full window after an older recorded limit expires', async () => {
    recordLimit('2000-01-01T00:00:00.000Z');
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: RESET });
  });

  it('retains an unknown reset instead of inventing availability', async () => {
    usage = null;
    recordLimit(null);
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: null });
  });

  it('never treats per-token billing as subscription usage', async () => {
    perToken = true;
    await expect(chatUsagePauseOf('dm')).resolves.toBeNull();
    recordLimit();
    await expect(chatUsagePauseOf('dm')).resolves.toEqual({ resetsAt: RESET });
  });

  it('never treats a cold credits root as subscription usage', async () => {
    root = creditsClaudeRoot();
    await expect(chatUsagePauseOf('dm')).resolves.toBeNull();
  });
});
