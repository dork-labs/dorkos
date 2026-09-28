import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { readConfigFile } from '../../../../core/usage/account-usage-reconcile.js';
import { defaultAccountFolder } from '../../../../core/usage/runtime-accounts.js';
import { claudeConfigDirEnv } from '../../claude-config-dir.js';
import {
  AccountUsageUnavailableError,
  PROBE_FLOOR_MS,
  probeAccount,
  resetAccountProbeState,
  UnknownAccountError,
  type AccountProbeDeps,
  type ProbeQueryFactory,
} from '../account-probe.js';

// A spy over the real function, so every test keeps the real env and one test
// can see which folder the probe asked it about.
vi.mock('../../claude-config-dir.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../claude-config-dir.js')>();
  return { ...actual, claudeConfigDirEnv: vi.fn(actual.claudeConfigDirEnv) };
});

let root: string;
let dorkHome: string;
let home: string;
let workPath: string;
let store: AccountUsageStore;
let clock: number;

/** Reset times ahead of the test clock, so neither window has rolled over. */
let RESETS_AT: string;
let SEVEN_DAY_RESETS_AT: string;

function usageResponse(
  overrides: Partial<SDKControlGetUsageResponse> = {}
): SDKControlGetUsageResponse {
  return {
    rate_limits_available: true,
    subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 42, resets_at: RESETS_AT },
      seven_day: { utilization: 17, resets_at: SEVEN_DAY_RESETS_AT },
    },
    ...overrides,
  } as unknown as SDKControlGetUsageResponse;
}

/** A fake SDK query that reads the prompt stream and records everything it is asked. */
function fakeQuery(answer: () => Promise<SDKControlGetUsageResponse>) {
  const calls = {
    options: [] as Array<Parameters<ProbeQueryFactory>[0]['options']>,
    usageArgs: [] as unknown[],
    yielded: 0,
    promptDone: false,
    closed: 0,
  };
  const factory = vi.fn<ProbeQueryFactory>(({ prompt, options }) => {
    calls.options.push(options);
    // Drain the prompt the way the CLI would, counting every message it hands over.
    void (async () => {
      for await (const _message of prompt as AsyncIterable<unknown>) calls.yielded++;
      calls.promptDone = true;
    })();
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async (opts?: unknown) => {
        calls.usageArgs.push(opts);
        return answer();
      }),
      close: vi.fn(() => {
        calls.closed++;
      }),
    };
  });
  return { factory, calls };
}

function deps(factory: ProbeQueryFactory, extra: Partial<AccountProbeDeps> = {}): AccountProbeDeps {
  return {
    queryFactory: factory,
    store,
    dorkHome,
    now: () => clock,
    binaryPath: undefined,
    ...extra,
  };
}

async function writeConfig(accounts: unknown[]): Promise<void> {
  await fs.writeFile(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({ runtimes: { claudeCode: { defaultAccount: null, accounts } } })
  );
}

async function startStore(): Promise<void> {
  store = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(path.join(dorkHome, 'config.json')),
    resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
    now: () => new Date(clock),
    lockOptions: { giveUpMs: 200 },
    timings: { scanIntervalMs: 3_600_000 },
  });
  await store.load();
}

/** Let the prompt-draining task observe a close. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-probe-')));
  dorkHome = path.join(root, 'dork');
  home = path.join(root, 'home');
  workPath = path.join(home, '.claude-work');
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await fs.mkdir(path.join(workPath, 'projects'), { recursive: true });
  clock = Date.now();
  RESETS_AT = new Date(clock + 3 * 3_600_000).toISOString();
  SEVEN_DAY_RESETS_AT = new Date(clock + 4 * 86_400_000).toISOString();
  resetAccountProbeState();
  await writeConfig([{ id: 'work', path: workPath, label: 'Work' }]);
  await startStore();
});

afterEach(async () => {
  store.stop();
  await store.flush();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const workUsage = () => store.list('claude-code').find((u) => u.accountId === 'work')!;

describe('probeAccount: an idle probe', () => {
  it('records the windows with their reset times, running no turn and keeping no transcript', async () => {
    const { factory, calls } = fakeQuery(async () => usageResponse());
    const result = await probeAccount('work', deps(factory));
    await settle();

    expect(result.probe).toBe('ok');
    expect(result.account.accountId).toBe('work');
    expect(result.account.subscriptionType).toBe('max');
    const fiveHour = result.account.windows.find((w) => w.key === 'five_hour');
    expect(fiveHour).toMatchObject({ usedPct: 42, resetsAt: RESETS_AT });
    expect(
      workUsage()
        .windows.map((w) => w.key)
        .sort()
    ).toEqual(['five_hour', 'seven_day']);

    // No turn: the prompt handed the CLI nothing and was closed.
    expect(calls.yielded).toBe(0);
    expect(calls.promptDone).toBe(true);
    // The usage call, once, skipping the local transcript scan.
    expect(calls.usageArgs).toEqual([{ skipBehaviors: true }]);
    expect(calls.closed).toBe(1);

    const options = calls.options[0]!;
    expect(options?.persistSession).toBe(false);
    expect(options?.settingSources).toEqual([]);
    expect(options?.mcpServers).toBeUndefined();
    expect(options?.plugins).toBeUndefined();
    expect(options?.cwd).toBe(path.join(dorkHome, 'cache', 'account-probe'));
    expect((await fs.stat(options!.cwd!)).isDirectory()).toBe(true);
    // The account's own folder.
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(workPath);
  });

  it('records nothing for an account with no plan limits, which stays unknown', async () => {
    const { factory, calls } = fakeQuery(async () =>
      usageResponse({ rate_limits_available: false, rate_limits: null } as never)
    );
    const result = await probeAccount('work', deps(factory));
    expect(result.probe).toBe('unavailable');
    expect(result.account.state).toBe('unknown');
    expect(workUsage().windows).toEqual([]);
    expect(calls.closed).toBe(1);
  });

  it('reads plan limits with no window readings as failed, recording nothing', async () => {
    const { factory, calls } = fakeQuery(async () =>
      usageResponse({ rate_limits: { five_hour: { utilization: null, resets_at: null } } } as never)
    );
    const result = await probeAccount('work', deps(factory));
    expect(result).toMatchObject({ probe: 'failed', reason: 'no-readings' });
    expect(result.account.state).toBe('unknown');
    expect(result.account.subscriptionType).toBeNull();
    expect(workUsage().windows).toEqual([]);
    expect(calls.closed).toBe(1);
  });

  it('reads a thrown usage call as failed, records nothing, and closes both ends', async () => {
    const { factory, calls } = fakeQuery(async () => {
      throw new Error('boom\nstack line');
    });
    const result = await probeAccount('work', deps(factory));
    await settle();
    expect(result).toMatchObject({ probe: 'failed', reason: 'boom' });
    expect(result.account.state).toBe('unknown');
    expect(workUsage().windows).toEqual([]);
    expect(calls.closed).toBe(1);
    expect(calls.promptDone).toBe(true);
  });

  it('gives up after the timeout, recording nothing and closing the query and the prompt', async () => {
    const { factory, calls } = fakeQuery(() => new Promise(() => {}));
    const result = await probeAccount('work', deps(factory, { timeoutMs: 20 }));
    await settle();
    expect(result).toMatchObject({ probe: 'failed', reason: 'timeout' });
    expect(workUsage().windows).toEqual([]);
    expect(calls.closed).toBe(1);
    expect(calls.promptDone).toBe(true);
  });

  it('reads a CLI without the usage call as failed', async () => {
    const close = vi.fn();
    const factory: ProbeQueryFactory = () =>
      ({ close }) as unknown as ReturnType<ProbeQueryFactory>;
    const result = await probeAccount('work', deps(factory));
    expect(result).toMatchObject({ probe: 'failed', reason: 'usage-unsupported' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses a folder that is not an account without starting the CLI', async () => {
    await fs.rm(path.join(workPath, 'projects'), { recursive: true });
    const { factory } = fakeQuery(async () => usageResponse());
    const result = await probeAccount('work', deps(factory));
    expect(result).toMatchObject({ probe: 'failed', reason: 'not-an-account' });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('probeAccount: which account', () => {
  it('throws UnknownAccountError for an id nobody registered', async () => {
    const { factory } = fakeQuery(async () => usageResponse());
    await expect(probeAccount('nobody', deps(factory))).rejects.toBeInstanceOf(UnknownAccountError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('probes this computer’s own sign-in as `default`, in the machine default folder', async () => {
    await writeConfig([]);
    store.stop();
    await startStore();
    const { factory, calls } = fakeQuery(async () => usageResponse());
    const result = await probeAccount('default', deps(factory));
    expect(result.probe).toBe('ok');
    expect(result.account.accountId).toBe('default');
    expect(calls.options[0]?.env).toBeDefined();
    // `~/.claude` in this test is not the real one, so the folder is named.
    expect(calls.options[0]?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'));
  });

  it('builds the CLI environment from the account root, so ~/.claude reaches it unset', async () => {
    const { factory, calls } = fakeQuery(async () => usageResponse());
    vi.mocked(claudeConfigDirEnv).mockClear();
    vi.mocked(claudeConfigDirEnv).mockReturnValueOnce({ CLAUDE_CONFIG_DIR: undefined });
    await probeAccount('work', deps(factory));
    expect(claudeConfigDirEnv).toHaveBeenCalledWith(workPath);
    // Its answer is what the CLI gets: an unset variable, not the folder.
    expect(calls.options[0]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('throws when the usage store is not running', async () => {
    const { factory } = fakeQuery(async () => usageResponse());
    await expect(
      probeAccount('work', { queryFactory: factory, store: undefined, dorkHome })
    ).rejects.toBeInstanceOf(AccountUsageUnavailableError);
  });
});

describe('probeAccount: throttle and single flight', () => {
  it('shares one probe between concurrent callers', async () => {
    let answer!: (r: SDKControlGetUsageResponse) => void;
    const { factory } = fakeQuery(
      () => new Promise<SDKControlGetUsageResponse>((resolve) => (answer = resolve))
    );
    const first = probeAccount('work', deps(factory));
    const second = probeAccount('work', deps(factory));
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer(usageResponse());
    const [a, b] = await Promise.all([first, second]);
    expect(factory).toHaveBeenCalledOnce();
    expect(a).toBe(b);
  });

  it('answers throttled with the current record inside the 60 s floor, then probes again', async () => {
    const { factory } = fakeQuery(async () => usageResponse());
    await probeAccount('work', deps(factory));

    clock += PROBE_FLOOR_MS - 1;
    const throttled = await probeAccount('work', deps(factory));
    expect(throttled.probe).toBe('throttled');
    expect(throttled.account.windows.length).toBe(2);
    expect(factory).toHaveBeenCalledOnce();

    clock += 1;
    expect((await probeAccount('work', deps(factory))).probe).toBe('ok');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('counts a failed attempt toward the floor', async () => {
    const { factory } = fakeQuery(async () => {
      throw new Error('boom');
    });
    await probeAccount('work', deps(factory));
    expect((await probeAccount('work', deps(factory))).probe).toBe('throttled');
    expect(factory).toHaveBeenCalledOnce();
  });
});
