/** Actual runtime launch ownership: unrelated global storage cannot grant or deny authority. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSeatLaunchRequirements, sessionMetadata, type Db } from '@dorkos/db';
import { RuntimeRegistry, runtimeRegistry } from '../../../core/runtime-registry.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { initBoundary } from '../../../../lib/boundary.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { sdkSimpleText, wrapSdkQuery } from './sdk-scenarios.js';
import { FakeCli, type FakeCliProcess } from '../sessions/__tests__/fake-persistent-cli.js';
import { SessionPumpRegistry } from '../sessions/session-pump-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
let scratch: string | undefined;
let runtime: ClaudeCodeRuntime | undefined;
afterEach(async () => {
  await runtime?.endSessionsWhere(() => true);
  runtime = undefined;
  clearTestHomes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function constrain(db: Db, id: string, home: string, root: string) {
  db.insert(roomSeatLaunchRequirements)
    .values({
      id: 'owner-required',
      destinationSessionId: id,
      sourceSessionId: 'prior',
      sourceDispatchId: 'prior-dispatch',
      startSeq: 1,
      endSeq: 8,
      state: 'settled',
      createdAt: 'now',
      payload: JSON.stringify({
        version: 1,
        roomId: 'room',
        authorId: 'author',
        runtime: 'claude-code',
        root,
        accountId: 'owner-account',
        inference: 'own-account',
        billing: 'subscription',
      }),
    })
    .run();
  db.insert(sessionMetadata)
    .values({
      sessionId: id,
      agentPath: home,
      runtime: 'claude-code',
      requiredLaunchId: 'owner-required',
      createdAt: 'now',
    })
    .run();
}

/** Existing SDK-edge helper, delegating live process controls to the real CLI double. */
function sdkQueryFor(process: FakeCliProcess) {
  const stream = (async function* () {
    for await (const frame of process) yield frame;
  })();
  return Object.assign(wrapSdkQuery(stream), {
    close: vi.fn(() => process.close()),
    interrupt: vi.fn().mockImplementation(() => process.interrupt()),
    setModel: vi.fn().mockImplementation((model?: string) => process.setModel(model)),
    setPermissionMode: vi
      .fn()
      .mockImplementation((mode: string) => process.setPermissionMode(mode)),
    setMcpServers: vi
      .fn()
      .mockImplementation((servers: Record<string, unknown>) => process.setMcpServers(servers)),
    reloadPlugins: vi.fn().mockImplementation(() => process.reloadPlugins()),
    supportedModels: vi.fn().mockImplementation(() => process.supportedModels()),
    supportedCommands: vi.fn().mockImplementation(() => process.supportedCommands()),
    mcpServerStatus: vi.fn().mockImplementation(() => process.mcpServerStatus()),
    getContextUsage: vi.fn().mockImplementation(() => process.getContextUsage()),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
      .fn()
      .mockImplementation(() =>
        process.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      ),
  });
}

async function fixture(persistent: boolean, requiredOwner: 'local' | 'global') {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4328-launch-owner-')));
  await initBoundary(scratch);
  const home = path.join(scratch, 'agent');
  const root = path.join(scratch, 'account');
  const dorkHome = path.join(scratch, 'dork');
  await Promise.all([home, root, dorkHome].map((dir) => mkdir(dir, { recursive: true })));
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    vi.stubEnv(key, '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('No network in owner oracle');
    })
  );
  const config = initConfigManager(dorkHome);
  config.setDot('runtimes.claudeCode.accounts', [
    { id: 'owner-account', label: 'Fixture', path: root },
  ]);
  config.setDot('runtimes.claudeCode.defaultAccount', root);
  config.setDot('runtimes.claudeCode.persistentSession', persistent);
  registerTestHomes([home]);
  await writeFile(
    path.join(root, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        accountUuid: randomUUID(),
        organizationUuid: randomUUID(),
      },
    })
  );
  // Deliberately changed billing, confined to an owned temporary account. SDK is fake.
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-never-network' } })
  );
  const localDb = createTestDb();
  const globalDb = createTestDb();
  const owner = new RuntimeRegistry();
  owner.setDb(localDb);
  runtimeRegistry.setDb(globalDb);
  const id = randomUUID();
  constrain(requiredOwner === 'local' ? localDb : globalDb, id, home, root);
  runtime = new ClaudeCodeRuntime(dorkHome, home);
  owner.register(runtime);
  runtime.setSessionSettings(owner);
  const cli = persistent ? new FakeCli() : undefined;
  const queries: Array<ReturnType<typeof sdkQueryFor>> = [];
  if (cli) {
    cli.nextSdkSessionId = id;
    vi.mocked(query, { partial: true }).mockImplementation(({ prompt, options }) => {
      if (typeof prompt === 'string' || !options)
        throw new Error('Persistent SDK fixture requires streaming prompt and options');
      const sdk = sdkQueryFor(cli.query({ prompt, options }));
      queries.push(sdk);
      return sdk;
    });
  } else {
    vi.mocked(query, { partial: true }).mockImplementation(() =>
      wrapSdkQuery(sdkSimpleText('ok', id))
    );
  }
  vi.mocked(query).mockClear();
  return { id, home, owner, localDb, globalDb, cli, queries };
}

/** Install a requirement matching the actual fixture CLI's user-key billing. */
function constrainMatching(f: Awaited<ReturnType<typeof fixture>>) {
  const root = path.join(scratch!, 'account');
  constrain(f.localDb, f.id, f.home, root);
  f.localDb
    .update(roomSeatLaunchRequirements)
    .set({
      payload: JSON.stringify({
        version: 1,
        roomId: 'room',
        authorId: 'author',
        runtime: 'claude-code',
        root,
        accountId: 'owner-account',
        inference: 'own-account',
        billing: 'per-token',
      }),
    })
    .where(eq(roomSeatLaunchRequirements.id, 'owner-required'))
    .run();
}

/** Use the established complete SDK init builder, altering only the observed facts. */
async function initFrame(id: string, apiKeySource: string) {
  const first = await sdkSimpleText('', id).next();
  if (first.done || first.value.type !== 'system' || first.value.subtype !== 'init') {
    throw new Error('SDK fixture did not produce an init frame');
  }
  // The unknown-source case deliberately crosses the external SDK's enum
  // boundary; keep that invalid raw field local rather than casting a session,
  // query, or the complete message structure to a broader contract.
  return { ...first.value, apiKeySource: apiKeySource as typeof first.value.apiKeySource };
}

describe.each([false, true])('required launch exact owner (persistent=%s)', (persistent) => {
  it('refuses changed billing from local required storage while global storage is ordinary', async () => {
    const f = await fixture(persistent, 'local');
    expect(f.owner.requiredLaunches().forSession(f.id)?.billing).toBe('subscription');
    expect(runtimeRegistry.requiredLaunches().forSession(f.id)).toBeNull();
    let failure: unknown;
    try {
      for await (const _ of runtime!.sendMessage(f.id, 'hello', {
        cwd: f.home,
        accountHint: 'owner-account',
      })) {
      }
    } catch (error) {
      failure = error;
    }
    expect(query).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/billing choice cannot be preserved/);
  });

  it('keeps local ordinary launches independent of a global required record for the same id', async () => {
    const f = await fixture(persistent, 'global');
    expect(f.owner.requiredLaunches().forSession(f.id)).toBeNull();
    expect(runtimeRegistry.requiredLaunches().forSession(f.id)?.billing).toBe('subscription');
    for await (const _ of runtime!.sendMessage(f.id, 'hello', {
      cwd: f.home,
      accountHint: 'owner-account',
    })) {
    }
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('required launch live stage owner', () => {
  it('keeps an affirmatively matching retained process usable without a new query', async () => {
    const f = await fixture(true, 'global');
    for await (const _ of runtime!.sendMessage(f.id, 'first turn', {
      cwd: f.home,
      accountHint: 'owner-account',
    })) {
    }
    constrainMatching(f);
    expect(
      await runtime!.deliverIntoTurn(f.id, 'matching required append', {
        mode: 'stage',
        messageId: 'matching-stage',
      })
    ).toEqual({ delivered: true });
    await vi.waitFor(() =>
      expect(f.cli!.processes[0]!.staged).toEqual([
        { uuid: 'matching-stage', content: 'matching required append' },
      ])
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['refused', 'corrupt'] as const)(
    'does not append after local authority becomes %s',
    async (variant) => {
      const f = await fixture(true, 'global');
      for await (const _ of runtime!.sendMessage(f.id, 'first turn', {
        cwd: f.home,
        accountHint: 'owner-account',
      })) {
      }
      const process = f.cli!.processes[0]!;
      expect(process.ended).toBe(false);
      expect(
        await runtime!.deliverIntoTurn(f.id, 'positive ordinary append', {
          mode: 'stage',
          messageId: 'positive-stage',
        })
      ).toEqual({ delivered: true });
      await vi.waitFor(() =>
        expect(process.staged).toEqual([
          { uuid: 'positive-stage', content: 'positive ordinary append' },
        ])
      );
      // Same owner now has a durable requirement. The process remains alive;
      // neither query-count nor a fresh-launch check can catch an append bypass.
      constrain(f.localDb, f.id, f.home, path.join(scratch!, 'account'));
      f.localDb
        .update(roomSeatLaunchRequirements)
        .set(variant === 'refused' ? { state: 'refused' } : { payload: '{broken' })
        .where(eq(roomSeatLaunchRequirements.id, 'owner-required'))
        .run();
      let result: unknown;
      try {
        result = await runtime!.deliverIntoTurn(f.id, 'forbidden append', {
          mode: 'stage',
          messageId: 'forbidden-stage',
        });
      } catch (error) {
        result = error;
      }
      expect(result).not.toEqual({ delivered: true });
      expect(
        result instanceof Error || (result as { delivered?: boolean })?.delivered === false
      ).toBe(true);
      expect(process.staged).toEqual([
        { uuid: 'positive-stage', content: 'positive ordinary append' },
      ]);
      expect(query).toHaveBeenCalledTimes(1);
    }
  );
});

describe('required launch retained-query correlation and retirement', () => {
  it.each(['unknown billing', 'unverified native id'] as const)(
    'refuses an actual live SDK frame with %s',
    async (variant) => {
      const f = await fixture(true, 'global');
      for await (const _ of runtime!.sendMessage(f.id, 'first turn', {
        cwd: f.home,
        accountHint: 'owner-account',
      })) {
      }
      constrainMatching(f);
      const process = f.cli!.processes[0]!;
      expect(
        await runtime!.deliverIntoTurn(f.id, 'known proof', {
          mode: 'stage',
          messageId: 'known-proof',
        })
      ).toEqual({ delivered: true });
      await vi.waitFor(() => expect(process.staged).toHaveLength(1));
      process.emit(
        await initFrame(
          variant === 'unverified native id' ? randomUUID() : f.id,
          variant === 'unknown billing' ? 'unknown_future_source' : 'user'
        )
      );
      // A macrotask lets the actual pump consume its queued SDK frame; there is
      // no test-only proof setter or invocation of the authority predicate.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(
        runtime!.deliverIntoTurn(f.id, 'must not append', { mode: 'stage', messageId: 'bad-proof' })
      ).rejects.toThrow('The retained recovery account or billing choice cannot be preserved.');
      expect(process.staged).toEqual([{ uuid: 'known-proof', content: 'known proof' }]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(runtime!.getInternalSessionId(f.id)).toBe(f.id);
    }
  );

  it.each(['matching', 'unverified'] as const)(
    'retires old proof and checks the %s replacement process native id',
    async (variant) => {
      const f = await fixture(true, 'global');
      for await (const _ of runtime!.sendMessage(f.id, 'first turn', {
        cwd: f.home,
        accountHint: 'owner-account',
      })) {
      }
      constrainMatching(f);
      const old = f.cli!.processes[0]!;
      expect(
        await runtime!.deliverIntoTurn(f.id, 'old process append', {
          mode: 'stage',
          messageId: 'old-stage',
        })
      ).toEqual({ delivered: true });
      await vi.waitFor(() => expect(old.staged).toHaveLength(1));
      await runtime!.reapSession(f.id);
      expect(old.ended).toBe(true);
      expect(runtime!.getSessionWarmth(f.id)).toBe('cold');
      f.cli!.nextSdkSessionId = variant === 'matching' ? f.id : randomUUID();
      const next = runtime!.deliverIntoTurn(f.id, 'replacement append', {
        mode: 'stage',
        messageId: 'new-stage',
      });
      if (variant === 'matching') {
        expect(await next).toEqual({ delivered: true });
        await vi.waitFor(() =>
          expect(f.cli!.processes[1]!.staged).toEqual([
            { uuid: 'new-stage', content: 'replacement append' },
          ])
        );
      } else {
        await expect(next).rejects.toThrow(
          'The retained recovery account or billing choice cannot be preserved.'
        );
        expect(f.cli!.processes[1]!.staged).toEqual([]);
      }
      expect(old.staged).toEqual([{ uuid: 'old-stage', content: 'old process append' }]);
      expect(query).toHaveBeenCalledTimes(2);
      expect(runtime!.getInternalSessionId(f.id)).toBe(f.id);
    }
  );

  it('ignores another actual query when a late observer call names a wrong native id', async () => {
    const acquire = vi.spyOn(SessionPumpRegistry.prototype, 'acquire');
    const f = await fixture(true, 'global');
    for await (const _ of runtime!.sendMessage(f.id, 'first turn', {
      cwd: f.home,
      accountHint: 'owner-account',
    })) {
    }
    const firstObserver = acquire.mock.calls.find(([id]) => id === f.id)?.[1].onMessage;
    expect(firstObserver).toBeTypeOf('function');
    constrainMatching(f);
    const otherId = randomUUID();
    f.cli!.nextSdkSessionId = otherId;
    for await (const _ of runtime!.sendMessage(otherId, 'independent turn', {
      cwd: f.home,
      accountHint: 'owner-account',
    })) {
    }
    const otherQuery = f.cli!.processes[1]!;
    // Exercise the actual captured observer with a different genuine SDK Query.
    // This is a callback ownership control, not an SDK stream-race claim.
    firstObserver!(await initFrame(otherId, 'user'), f.queries[1]!);
    expect(
      await runtime!.deliverIntoTurn(f.id, 'still owned', {
        mode: 'stage',
        messageId: 'still-owned',
      })
    ).toEqual({ delivered: true });
    await vi.waitFor(() =>
      expect(f.cli!.processes[0]!.staged).toEqual([{ uuid: 'still-owned', content: 'still owned' }])
    );
    for await (const _ of runtime!.sendMessage(otherId, 'independent next turn', {
      cwd: f.home,
      accountHint: 'owner-account',
    })) {
    }
    expect(otherQuery.answered).toBe(2);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('required launch owner responsibility', () => {
  it('preserves the exact owner read error rather than treating it as ordinary', async () => {
    const f = await fixture(false, 'global');
    const refusal = new Error('isolated owner read failed');
    vi.spyOn(f.owner, 'requiredLaunches').mockImplementation(() => {
      throw refusal;
    });
    // Re-inject because the capability deliberately captures a bound method,
    // not a global lookup. Its own body still reads current owner storage.
    runtime!.setSessionSettings(f.owner);
    let actual: unknown;
    try {
      for await (const _ of runtime!.sendMessage(f.id, 'hello')) {
      }
    } catch (error) {
      actual = error;
    }
    expect(actual).toBe(refusal);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not let a capability-erasing wrapper certify ordinary authority', async () => {
    const f = await fixture(false, 'local');
    const erased = new Proxy(f.owner, {
      get(target, key) {
        if (key === 'requiredLaunches') return undefined;
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    runtime!.setSessionSettings(erased);
    await expect(async () => {
      for await (const _ of runtime!.sendMessage(f.id, 'hello')) {
      }
    }).rejects.toThrow('Recovery launch authority is unavailable.');
    expect(query).not.toHaveBeenCalled();
  });

  it('reads replacement storage through the bound owner instead of capturing a stale store', async () => {
    const f = await fixture(false, 'global');
    expect(f.owner.requiredLaunches().forSession(f.id)).toBeNull();
    f.owner.setDb(f.globalDb);
    await expect(async () => {
      for await (const _ of runtime!.sendMessage(f.id, 'hello')) {
      }
    }).rejects.toThrow('The recovery account or billing choice cannot be preserved.');
    expect(query).not.toHaveBeenCalled();
  });
});
