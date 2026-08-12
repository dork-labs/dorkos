/**
 * The relaunch pin list (spec `persistent-session-runtime` §4.5, task 3.5).
 *
 * The account cases are the reason this file exists. Everything else here is a
 * correctness test; those are a billing test — a dispatch that rides a process
 * launched under another client's account runs and BILLS on that client.
 */
import { describe, it, expect } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  PIN_DISPOSITIONS,
  RELAUNCH_PINS,
  LIVE_PINS,
  accountsMatch,
  captureLaunchFingerprint,
  compareLaunchFingerprints,
  type LaunchParams,
} from '../launch-fingerprint.js';

/** The account a paying client's session belongs to. */
const CLIENT_ROOT = '/staged/claude-client';
/** A different account entirely — the one a leak would bill to. */
const OTHER_ROOT = '/staged/claude-other';

/** The SDK options a launch would pass, with `overrides` folded in. */
function options(overrides: Partial<Options> = {}): Options {
  return {
    cwd: '/repo',
    settingSources: ['local', 'project', 'user'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base append' },
    permissionMode: 'default',
    model: 'claude-opus-4-6',
    effort: 'high',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: CLIENT_ROOT },
    ...overrides,
  } as Options;
}

/** Launch params for `root`, with `overrides` folded in. */
function params(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    accountRoot: CLIENT_ROOT,
    options: options(),
    credentialEnv: { ANTHROPIC_API_KEY: 'sk-client' },
    agentIdentity: { agentPath: '/repo', displayName: 'Scout', attributed: true },
    ...overrides,
  };
}

/** Capture a fingerprint from `overrides` on top of the baseline launch. */
function capture(overrides: Partial<LaunchParams> = {}) {
  return captureLaunchFingerprint(params(overrides));
}

describe('the pin list', () => {
  it('enumerates exactly the rows of spec §4.5, with the disposition each row states', () => {
    // Drift guard. The spec's table has ten rows; three of them
    // (`model`/`effort`/`fastMode`, and `settingSources`/`env`) name more than
    // one field, and each field gets its own verdict here. A launch option
    // added without a decision fails this.
    expect(PIN_DISPOSITIONS).toEqual({
      cwd: 'relaunch',
      accountRoot: 'relaunch',
      credentialEnv: 'relaunch',
      agentIdentity: 'relaunch',
      systemPromptAppend: 'relaunch',
      settingSources: 'relaunch',
      env: 'relaunch',
      effort: 'relaunch',
      fastMode: 'relaunch',
      mcpServers: 'live',
      plugins: 'live',
      permissionMode: 'live',
      model: 'live',
    });
  });

  it('splits into a relaunch set and a live set that together cover every pin', () => {
    expect([...RELAUNCH_PINS, ...LIVE_PINS].sort()).toEqual(Object.keys(PIN_DISPOSITIONS).sort());
    expect(RELAUNCH_PINS.filter((pin) => LIVE_PINS.includes(pin as never))).toEqual([]);
  });

  it('records a value for every relaunch pin and every live pin', () => {
    const fingerprint = capture();
    expect(Object.keys(fingerprint.pins).sort()).toEqual([...RELAUNCH_PINS].sort());
    expect(Object.keys(fingerprint.live).sort()).toEqual([...LIVE_PINS].sort());
  });
});

describe('the account pin', () => {
  it('refuses to be captured when the env does not pin the account the launch declares', () => {
    // A launch whose `CLAUDE_CONFIG_DIR` names one account while the launcher
    // believes it resolved another is the exact shape of the billing bug. It is
    // caught at capture, before the process is ever reused.
    expect(() =>
      captureLaunchFingerprint(
        params({ options: options({ env: { CLAUDE_CONFIG_DIR: OTHER_ROOT } }) })
      )
    ).toThrow(/account/i);
  });

  it('forces a relaunch when the session moves to another account', () => {
    const decision = compareLaunchFingerprints(
      capture(),
      capture({
        accountRoot: OTHER_ROOT,
        options: options({ env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: OTHER_ROOT } }),
      })
    );
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toContain('accountRoot');
  });

  it('forces a relaunch when only the spelled CLAUDE_CONFIG_DIR moves, root unchanged', () => {
    // Absence and a path are different accounts to Claude Code's Keychain even
    // when the resolved root is the same string, so both halves are compared.
    const spelled = capture();
    // The launcher on the DEFAULT root spells it by ABSENCE (`claudeConfigDirEnv`).
    const absent = capture({ options: options({ env: { PATH: '/usr/bin' } }) });
    const decision = compareLaunchFingerprints(spelled, absent);
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toContain('accountRoot');
  });

  it('relaunches on an account change even when everything else is only live-settable', () => {
    // The mutation this pins: a compare that answers the cheap live diff first
    // and never reaches the account. A different account may NEVER be reached
    // by the reuse path, whatever else is different.
    const decision = compareLaunchFingerprints(
      capture(),
      capture({
        accountRoot: OTHER_ROOT,
        options: options({
          env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: OTHER_ROOT },
          model: 'claude-sonnet-4-6',
          permissionMode: 'plan',
        }),
      })
    );
    expect(decision.action).toBe('relaunch');
    expect('liveChanges' in decision).toBe(false);
  });

  it('relaunches on an account change even when the two fingerprints are otherwise identical', () => {
    // The mutation this pins: an `if (live === next) return reuse` fast path, or
    // any equality shortcut computed before the account is consulted.
    const live = capture();
    const next = { ...live, account: { root: OTHER_ROOT, configDirEnv: OTHER_ROOT } };
    const decision = compareLaunchFingerprints(live, next);
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toContain('accountRoot');
  });

  it('says two accounts match only when both the root and its spelling agree', () => {
    expect(accountsMatch({ root: CLIENT_ROOT, configDirEnv: CLIENT_ROOT }, capture().account)).toBe(
      true
    );
    expect(
      accountsMatch(
        { root: CLIENT_ROOT, configDirEnv: CLIENT_ROOT },
        { root: OTHER_ROOT, configDirEnv: OTHER_ROOT }
      )
    ).toBe(false);
    expect(
      accountsMatch(
        { root: CLIENT_ROOT, configDirEnv: CLIENT_ROOT },
        { root: CLIENT_ROOT, configDirEnv: undefined }
      )
    ).toBe(false);
    // Each half must decide on its own, so vary ONE at a time. Above, only the
    // spelling moves; here, only the root — a check that compared just the
    // spelling would call these two the same account, and they are not. (Both
    // launches pin the default root by ABSENCE, which is the one shape where the
    // capture-time check cannot tie the root to the spelling.)
    expect(
      accountsMatch(
        { root: CLIENT_ROOT, configDirEnv: undefined },
        { root: OTHER_ROOT, configDirEnv: undefined }
      )
    ).toBe(false);
    // Trailing separators are the same directory, not a second account.
    expect(
      accountsMatch(
        { root: `${CLIENT_ROOT}/`, configDirEnv: CLIENT_ROOT },
        { root: CLIENT_ROOT, configDirEnv: CLIENT_ROOT }
      )
    ).toBe(true);
  });

  it('carries the spelling in the accountRoot pin as well as in the account row', () => {
    // The account is deliberately compared twice — once unconditionally through
    // `accountsMatch`, once through the ordinary pin loop. `accountsMatch` alone
    // catches every case, so nothing else here can fail if the pin row quietly
    // stops carrying the spelling. This asserts the second layer directly, so
    // the redundancy cannot be refactored away unnoticed.
    const spelled = capture();
    const absent = capture({ options: options({ env: { PATH: '/usr/bin' } }) });
    expect(spelled.pins.accountRoot).not.toBe(absent.pins.accountRoot);
  });

  it('keeps no secret in the relaunch reason', () => {
    const decision = compareLaunchFingerprints(
      capture(),
      capture({ credentialEnv: { ANTHROPIC_API_KEY: 'sk-someone-else' } })
    );
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.reason).not.toContain('sk-');
  });
});

describe('the relaunch pins', () => {
  const cases: ReadonlyArray<[string, Partial<LaunchParams>]> = [
    ['cwd', { options: options({ cwd: '/elsewhere' }) }],
    ['credentialEnv', { credentialEnv: { ANTHROPIC_API_KEY: 'sk-rotated' } }],
    ['credentialEnv', { credentialEnv: {} }],
    [
      'agentIdentity',
      { agentIdentity: { agentPath: '/other', displayName: 'Scout', attributed: true } },
    ],
    ['agentIdentity', { agentIdentity: undefined }],
    [
      'systemPromptAppend',
      {
        options: options({
          systemPrompt: { type: 'preset', preset: 'claude_code', append: 'different append' },
        }),
      },
    ],
    ['settingSources', { options: options({ settingSources: ['user'] }) }],
    [
      'env',
      {
        options: options({ env: { PATH: '/usr/bin', EXTRA: '1', CLAUDE_CONFIG_DIR: CLIENT_ROOT } }),
      },
    ],
    ['effort', { options: options({ effort: 'low' }) }],
    ['effort', { options: options({ thinking: { type: 'adaptive', display: 'summarized' } }) }],
    ['fastMode', { options: options({ settings: { fastMode: true } }) }],
  ];

  it.each(cases)('relaunches when %s changes', (pin, overrides) => {
    const decision = compareLaunchFingerprints(capture(), capture(overrides));
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toContain(pin);
  });

  it('does not relaunch when a freshly minted agent token replaces an identical one', () => {
    // The token VALUE is re-minted on every resolution (`agent-identity-service.mint`
    // returns fresh random bytes), so pinning it would relaunch on every single
    // dispatch and warmth would never exist. The pin is the IDENTITY behind it.
    const decision = compareLaunchFingerprints(
      capture({
        options: options({
          env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: CLIENT_ROOT, DORKOS_AGENT_TOKEN: 'tok-1' },
        }),
      }),
      capture({
        options: options({
          env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: CLIENT_ROOT, DORKOS_AGENT_TOKEN: 'tok-2' },
        }),
      })
    );
    expect(decision.action).toBe('reuse');
  });

  it('relaunches when a launch that could not attribute itself is asked to attribute', () => {
    const decision = compareLaunchFingerprints(
      capture({ agentIdentity: { agentPath: '/repo', displayName: 'Scout', attributed: false } }),
      capture()
    );
    expect(decision.action).toBe('relaunch');
    expect(decision.action === 'relaunch' && decision.changed).toContain('agentIdentity');
  });

  it('reports every pin that moved, not just the first', () => {
    const decision = compareLaunchFingerprints(
      capture(),
      capture({ options: options({ cwd: '/elsewhere', settingSources: ['user'] }) })
    );
    expect(decision.action === 'relaunch' && [...decision.changed].sort()).toEqual([
      'cwd',
      'settingSources',
    ]);
  });
});

describe('across two dispatches', () => {
  it('relaunches once, then rides the new process', () => {
    // Acceptance criterion 1's shape without the pump: a changed pin must cost
    // exactly ONE relaunch, not one per dispatch forever. The second dispatch
    // compares against the fingerprint the RELAUNCH captured.
    const first = capture();
    const wanted = capture({ options: options({ cwd: '/elsewhere' }) });
    expect(compareLaunchFingerprints(first, wanted).action).toBe('relaunch');

    const relaunched = capture({ options: options({ cwd: '/elsewhere' }) });
    const second = compareLaunchFingerprints(relaunched, wanted);
    expect(second.action).toBe('reuse');
    expect(second.action === 'reuse' && second.liveChanges).toEqual([]);
  });

  it('is not a boundary check: a matching fingerprint says nothing about the cwd', () => {
    // Spec §4.5 acceptance 6. Boundary validation is task 3.9's, and it must not
    // be assumed to have happened because two fingerprints agree — two launches
    // OUTSIDE the boundary agree with each other perfectly.
    const outside = { options: options({ cwd: '/etc' }) };
    expect(compareLaunchFingerprints(capture(outside), capture(outside)).action).toBe('reuse');
  });
});

describe('the live pins', () => {
  it('rides the warm process when nothing moved, with nothing to apply', () => {
    const decision = compareLaunchFingerprints(capture(), capture());
    expect(decision.action).toBe('reuse');
    expect(decision.action === 'reuse' && decision.liveChanges).toEqual([]);
  });

  it.each([
    ['model', { model: 'claude-sonnet-4-6' }],
    ['permissionMode', { permissionMode: 'plan' as const }],
    ['plugins', { plugins: [{ type: 'local' as const, path: '/plugins/flow' }] }],
  ])('rides the warm process when %s changes, and reports the change', (pin, override) => {
    const decision = compareLaunchFingerprints(capture(), capture({ options: options(override) }));
    expect(decision.action).toBe('reuse');
    expect(decision.action === 'reuse' && decision.liveChanges.map((c) => c.pin)).toEqual([pin]);
  });

  it('rides the warm process when the MCP server set changes', () => {
    const decision = compareLaunchFingerprints(
      capture(),
      capture({
        options: options({
          mcpServers: { dorkos: { type: 'http', url: 'http://localhost:4242/mcp' } },
        }),
      })
    );
    expect(decision.action).toBe('reuse');
    expect(decision.action === 'reuse' && decision.liveChanges.map((c) => c.pin)).toEqual([
      'mcpServers',
    ]);
  });

  it.each([
    [
      'a rotated bearer header on an http server',
      (token: string) => ({
        gh: { type: 'http' as const, url: 'https://x/mcp', headers: { Authorization: token } },
      }),
    ],
    [
      'a rotated credential in a stdio server env',
      (token: string) => ({ db: { type: 'stdio' as const, command: 'srv', env: { KEY: token } } }),
    ],
  ])('moves the warm process onto %s', (_label, build) => {
    // `mcp-server-config.ts` fills both fields from the session's connector
    // accounts, so this is a connector's credential changing under a warm
    // process. Comparing name and URL alone read it as "no change", left
    // `setMcpServers` unfired, and kept the process on the OLD credential.
    const decision = compareLaunchFingerprints(
      capture({ options: options({ mcpServers: build('old-secret') }) }),
      capture({ options: options({ mcpServers: build('new-secret') }) })
    );
    expect(decision.action).toBe('reuse');
    expect(decision.action === 'reuse' && decision.liveChanges.map((c) => c.pin)).toEqual([
      'mcpServers',
    ]);
  });

  it('keeps MCP credentials out of the fingerprint it compares', () => {
    const fingerprint = capture({
      options: options({
        mcpServers: {
          gh: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer hunter2' } },
        },
      }),
    });
    // The comparable descriptor is hashed; the raw config stays only in `live`,
    // which exists to be handed back to `setMcpServers` and is never logged.
    expect(JSON.stringify(fingerprint.pins)).not.toContain('hunter2');
  });

  it('does not call setMcpServers for a fresh instance of the same in-process server', () => {
    // The factory builds new `McpServer` objects per launch on purpose
    // ("Already connected to a transport"), so instance identity says nothing.
    // Reconnecting every server on every dispatch would be a real cost.
    const withInstance = (instance: object) =>
      capture({
        options: options({
          mcpServers: { dorkos: { type: 'sdk', name: 'dorkos', instance } as never },
        }),
      });
    const decision = compareLaunchFingerprints(withInstance({ a: 1 }), withInstance({ a: 2 }));
    expect(decision.action === 'reuse' && decision.liveChanges).toEqual([]);
  });
});
