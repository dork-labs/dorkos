/**
 * The settable-live half of the pin list, and the dispatch-preparation entry
 * point 3.10 calls (spec `persistent-session-runtime` §4.5, task 3.5).
 *
 * The control double answers on a LATER macrotask, exactly as
 * `fake-pump-query.ts` does and for the same reason: a setter that is fired but
 * never awaited passes against a synchronous double and fails against this one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  captureLaunchFingerprint,
  AccountPinViolationError,
  type LaunchParams,
} from '../launch-fingerprint.js';
import { applyLiveChanges, prepareDispatch } from '../launch-live-settings.js';
import type { PumpControlQuery } from '../session-pump-contract.js';

const CLIENT_ROOT = '/staged/claude-client';
const OTHER_ROOT = '/staged/claude-other';

/** The SDK options a launch would pass, with `overrides` folded in. */
function options(overrides: Partial<Options> = {}): Options {
  return {
    cwd: '/repo',
    settingSources: ['local', 'project', 'user'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base append' },
    permissionMode: 'default',
    model: 'claude-opus-4-6',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: CLIENT_ROOT },
    ...overrides,
  } as Options;
}

/** Capture a fingerprint from `overrides` on top of the baseline launch. */
function capture(overrides: Partial<LaunchParams> = {}) {
  return captureLaunchFingerprint({
    accountRoot: CLIENT_ROOT,
    options: options(),
    credentialEnv: {},
    agentIdentity: undefined,
    effortInput: undefined,
    capabilityResolved: true,
    ...overrides,
  });
}

/** The order every control answer was resolved in, plus the spies that log it. */
function controlQuery() {
  const calls: string[] = [];
  /** Settle on a later macrotask, as a real control round-trip does. */
  const answer = (name: string) =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        calls.push(name);
        resolve();
      }, 0)
    );
  const query = {
    getContextUsage: vi.fn(),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(),
    setModel: vi.fn((model?: string) => answer(`setModel:${model ?? '<default>'}`)),
    setPermissionMode: vi.fn((mode: string) => answer(`setPermissionMode:${mode}`)),
    setMcpServers: vi.fn(() => answer('setMcpServers').then(() => ({}))),
    reloadPlugins: vi.fn(() => answer('reloadPlugins').then(() => ({}))),
  } as unknown as PumpControlQuery & { readonly calls: string[] };
  return { query, calls };
}

describe('applyLiveChanges', () => {
  it('sets the model on the live process, and waits for the answer', async () => {
    const { query, calls } = controlQuery();
    const decision = prepareDispatch(capture(), capture({ options: options({ model: 'sonnet' }) }));
    expect(decision.action).toBe('reuse');
    if (decision.action !== 'reuse') return;

    await applyLiveChanges(query, decision);

    expect(calls).toEqual(['setModel:sonnet']);
  });

  it('sets the permission mode without replacing the process', async () => {
    const { query, calls } = controlQuery();
    const decision = prepareDispatch(
      capture(),
      capture({ options: options({ permissionMode: 'plan' }) })
    );
    if (decision.action !== 'reuse') throw new Error('expected a reuse');

    await applyLiveChanges(query, decision);

    expect(calls).toEqual(['setPermissionMode:plan']);
  });

  it('swaps the MCP servers and reloads plugins in one pass', async () => {
    const { query, calls } = controlQuery();
    const decision = prepareDispatch(
      capture(),
      capture({
        options: options({
          mcpServers: { dorkos: { type: 'http', url: 'http://localhost:4242/mcp' } },
          plugins: [{ type: 'local', path: '/plugins/flow' }],
        }),
      })
    );
    if (decision.action !== 'reuse') throw new Error('expected a reuse');

    await applyLiveChanges(query, decision);

    expect(calls.sort()).toEqual(['reloadPlugins', 'setMcpServers']);
  });

  it('touches nothing when nothing moved', async () => {
    const { query, calls } = controlQuery();
    const decision = prepareDispatch(capture(), capture());
    if (decision.action !== 'reuse') throw new Error('expected a reuse');

    await applyLiveChanges(query, decision);

    expect(calls).toEqual([]);
  });

  it('refuses, and touches nothing, when the two accounts differ', async () => {
    // The second, independent account check. `prepareDispatch` cannot hand out a
    // cross-account reuse — so this forges one, which is exactly the mutation
    // being defended against: a caller (or a future refactor) that builds the
    // plan itself must still not be able to reach the setters.
    const { query, calls } = controlQuery();
    const forged = {
      action: 'reuse' as const,
      from: capture(),
      to: { ...capture(), account: { root: OTHER_ROOT, configDirEnv: OTHER_ROOT } },
      liveChanges: [{ pin: 'model' as const, model: 'sonnet' }],
    };

    await expect(applyLiveChanges(query, forged)).rejects.toBeInstanceOf(AccountPinViolationError);
    expect(calls).toEqual([]);
  });
});

describe('prepareDispatch', () => {
  it('tells the caller to relaunch, and which pins moved, so 3.10 can reap first', () => {
    const decision = prepareDispatch(
      capture(),
      capture({ options: options({ cwd: '/elsewhere' }) })
    );
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toEqual(['cwd']);
  });

  it('never answers reuse across accounts', () => {
    const decision = prepareDispatch(
      capture(),
      capture({
        accountRoot: OTHER_ROOT,
        options: options({ env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: OTHER_ROOT } }),
      })
    );
    expect(decision.action).toBe('relaunch');
  });
});
