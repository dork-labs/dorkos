import { describe, it, expect } from 'vitest';
import { STATUS_BAR_PIN_KEYS, STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import {
  STATUS_BAR_REGISTRY,
  getGroupedRegistryItems,
  getStatusBarItem,
  gitPromotionState,
  isPinnable,
  type StatusBarItemKey,
  type StatusPromotionContext,
} from '../model/status-bar-registry';

/** A resting session: connected, default everything, nothing to report. */
function restingContext(overrides: Partial<StatusPromotionContext> = {}): StatusPromotionContext {
  return {
    cwd: '/work/repo',
    git: { dirty: false, onDefaultBranch: true },
    contextPercent: 12,
    connectionState: 'connected',
    permissionMode: 'default',
    permissionDescriptor: null,
    plan: null,
    runtime: { isDefault: true, canSelect: false },
    usage: { kind: 'pay-as-you-go', costUsd: 0.03 },
    subagentsInFlight: 0,
    ...overrides,
  };
}

/** Which keys promote for a given context. */
function promotedKeys(ctx: StatusPromotionContext): StatusBarItemKey[] {
  return STATUS_BAR_REGISTRY.filter((item) => !item.neverInLine && item.promote(ctx)).map(
    (item) => item.key
  );
}

/** Resolve one item's severity for a context. */
function severityOf(key: StatusBarItemKey, ctx: StatusPromotionContext): number {
  return getStatusBarItem(key)!.severity(ctx);
}

describe('STATUS_BAR_REGISTRY — quiet by default', () => {
  it('shows only identity, directory, and model on a resting session', () => {
    // A creeping $0.03 and a 12%-full window are wallpaper. If they showed here,
    // the 91% that matters would not register either.
    expect(promotedKeys(restingContext())).toEqual(['agent', 'cwd', 'model']);
  });

  it('never lets cache or refresh into the line', () => {
    const neverInLine = STATUS_BAR_REGISTRY.filter((item) => item.neverInLine).map((i) => i.key);
    expect(neverInLine).toEqual(['cache', 'polling']);
  });

  it('has a unique key per item', () => {
    const keys = STATUS_BAR_REGISTRY.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts identity, directory, and git in the left cluster and everything else right', () => {
    const left = STATUS_BAR_REGISTRY.filter((i) => i.cluster === 'left').map((i) => i.key);
    expect(left).toEqual(['agent', 'cwd', 'git']);
  });
});

describe('STATUS_BAR_REGISTRY — promotion rules', () => {
  it('promotes git when the working tree is dirty', () => {
    expect(promotedKeys(restingContext({ git: { dirty: true, onDefaultBranch: true } }))).toContain(
      'git'
    );
  });

  it('promotes git when the branch is not the default', () => {
    expect(
      promotedKeys(restingContext({ git: { dirty: false, onDefaultBranch: false } }))
    ).toContain('git');
  });

  it('keeps git quiet on a clean default branch', () => {
    expect(promotedKeys(restingContext())).not.toContain('git');
  });

  it('promotes context at 70% and not at 69%', () => {
    expect(promotedKeys(restingContext({ contextPercent: 69 }))).not.toContain('context');
    expect(promotedKeys(restingContext({ contextPercent: 70 }))).toContain('context');
  });

  it('keeps context quiet before the first reading', () => {
    expect(promotedKeys(restingContext({ contextPercent: null }))).not.toContain('context');
  });

  it.each(['connecting', 'reconnecting', 'disconnected'] as const)(
    'promotes connection when the stream is %s',
    (state) => {
      expect(promotedKeys(restingContext({ connectionState: state }))).toContain('connection');
    }
  );

  it.each(['plan', 'acceptEdits', 'bypassPermissions', 'auto'] as const)(
    'promotes permissions in %s mode',
    (mode) => {
      expect(promotedKeys(restingContext({ permissionMode: mode }))).toContain('permission');
    }
  );

  it('promotes runtime when it is not the default', () => {
    expect(
      promotedKeys(restingContext({ runtime: { isDefault: false, canSelect: false } }))
    ).toContain('runtime');
  });

  it('promotes runtime pre-launch, while it can still be chosen', () => {
    expect(
      promotedKeys(restingContext({ runtime: { isDefault: true, canSelect: true } }))
    ).toContain('runtime');
  });

  it('keeps runtime quiet on a started session using the default', () => {
    expect(promotedKeys(restingContext())).not.toContain('runtime');
  });

  it.each(['warning', 'exhausted'] as const)('promotes usage when it is %s', (state) => {
    expect(
      promotedKeys(restingContext({ usage: { kind: 'subscription', utilization: 0.9, state } }))
    ).toContain('usage');
  });

  it('keeps usage quiet while it is healthy', () => {
    expect(promotedKeys(restingContext())).not.toContain('usage');
  });

  it('promotes subagents once one is actually running', () => {
    expect(promotedKeys(restingContext({ subagentsInFlight: 1 }))).toContain('subagents');
  });

  it('stays quiet about subagents a session merely could call', () => {
    // The rule used to read `getSubagents()` — the runtime's catalogue of agent
    // types, a fixed non-empty list for Claude Code — so the item promoted on
    // every session forever (DOR-462). The context now carries the running count,
    // which is 0 on a resting session, so the item has nothing to say.
    expect(promotedKeys(restingContext())).not.toContain('subagents');
    expect(severityOf('subagents', restingContext())).toBe(
      severityOf('subagents', restingContext({ subagentsInFlight: 0 }))
    );
  });

  it('offers Plan whenever the runtime has one, on or off — a switch nobody can find is not a switch', () => {
    expect(promotedKeys(restingContext({ plan: { active: false } }))).toContain('plan');
    expect(promotedKeys(restingContext({ plan: { active: true } }))).toContain('plan');
  });

  it('never offers Plan on a runtime that declares no way of working', () => {
    expect(promotedKeys(restingContext({ plan: null }))).not.toContain('plan');
  });

  it('ranks planning with an elevated permission mode, and an idle switch with the wallpaper', () => {
    const planning = severityOf('plan', restingContext({ plan: { active: true } }));
    const idle = severityOf('plan', restingContext({ plan: { active: false } }));
    expect(planning).toBe(severityOf('permission', restingContext({ permissionMode: 'plan' })));
    expect(idle).toBeLessThan(planning);
  });

  it('keeps the directory out when it is unresolved', () => {
    expect(promotedKeys(restingContext({ cwd: null }))).not.toContain('cwd');
  });
});

describe('STATUS_BAR_REGISTRY — numbers are rigid', () => {
  it('marks exactly the items whose value is a number', () => {
    // The row may squeeze a name into an ellipsis, because `Bypass permi…` is the
    // same fact in fewer letters. It may not do that to a number: `8…` reads as 8%
    // when the window is 88% full (DOR-461 review). Anything added here has to be
    // a number, and any number added to the line has to be added here — the
    // alternative is an item that renders outside its own box, which is how all
    // three of these were found.
    const rigid = STATUS_BAR_REGISTRY.filter((i) => i.rigid).map((i) => i.key);
    expect(rigid).toEqual(['context', 'usage', 'subagents']);
  });

  it('protects a count, which has no label to give up instead', () => {
    // Squeezed, `12` loses a digit and reads as `1` — with the ellipsis clipped
    // too, so it does not even look cut (DOR-461 review). There is no label in the
    // item to abbreviate first, so the row must not be able to ask. The width that
    // makes this affordable is the bare count: ~36px, which its shrink floor
    // reserved anyway.
    expect(getStatusBarItem('subagents')?.rigid).toBe(true);
  });

  it('leaves every label-bearing item free to truncate', () => {
    for (const key of ['agent', 'cwd', 'git', 'runtime', 'model', 'permission', 'connection']) {
      expect(getStatusBarItem(key as StatusBarItemKey)?.rigid).toBeUndefined();
    }
  });
});

describe('STATUS_BAR_REGISTRY — severity ranking', () => {
  it('ranks the degraded state exactly as specified, highest first', () => {
    // The order the mobile budget fills slots in: connection lost, context at the
    // ceiling, usage exhausted, keys-handed-over permissions, context merely
    // warning, elevated permissions, running subagents, non-default runtime, dirty
    // git, model, directory.
    const ranked: [StatusBarItemKey, StatusPromotionContext][] = [
      ['connection', restingContext({ connectionState: 'disconnected' })],
      ['context', restingContext({ contextPercent: 88 })],
      ['usage', restingContext({ usage: { kind: 'subscription', state: 'exhausted' } })],
      ['permission', restingContext({ permissionMode: 'bypassPermissions' })],
      ['context', restingContext({ contextPercent: 74 })],
      ['permission', restingContext({ permissionMode: 'plan' })],
      ['subagents', restingContext({ subagentsInFlight: 2 })],
      ['runtime', restingContext({ runtime: { isDefault: false, canSelect: false } })],
      ['git', restingContext({ git: { dirty: true, onDefaultBranch: true } })],
      ['model', restingContext()],
      ['cwd', restingContext()],
    ];
    const scores = ranked.map(([key, ctx]) => severityOf(key, ctx));

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it('never lets running subagents outrank a usage or context warning', () => {
    // A delegated turn is news; a number heading for a ceiling is a problem. When
    // one slot is left the problem takes it. Ranked at 60, subagents took that
    // slot and put the usage warning under the `⋯` (DOR-462).
    const subagents = severityOf('subagents', restingContext({ subagentsInFlight: 3 }));
    const usageWarning = severityOf(
      'usage',
      restingContext({ usage: { kind: 'subscription', state: 'warning' } })
    );
    const contextWarning = severityOf('context', restingContext({ contextPercent: 74 }));
    const elevated = severityOf('permission', restingContext({ permissionMode: 'plan' }));

    expect(subagents).toBeLessThan(usageWarning);
    expect(subagents).toBeLessThan(contextWarning);
    expect(subagents).toBeLessThan(elevated);
    // Still above the configuration facts — it is news, just never a problem.
    expect(subagents).toBeGreaterThan(
      severityOf('runtime', restingContext({ runtime: { isDefault: false, canSelect: false } }))
    );
  });

  it('ties a warning-level usage with a warning-level context', () => {
    // The spec lists them at one rank; a tie is the honest encoding of that.
    expect(
      severityOf('usage', restingContext({ usage: { kind: 'subscription', state: 'warning' } }))
    ).toBe(severityOf('context', restingContext({ contextPercent: 74 })));
  });

  it('ranks a context at the action threshold above one merely promoted', () => {
    expect(severityOf('context', restingContext({ contextPercent: 85 }))).toBeGreaterThan(
      severityOf('context', restingContext({ contextPercent: 84 }))
    );
  });

  it('never lets the identity anchor be outranked', () => {
    expect(severityOf('agent', restingContext())).toBeGreaterThan(
      severityOf('connection', restingContext({ connectionState: 'disconnected' }))
    );
  });
});

describe('gitPromotionState', () => {
  it.each(['main', 'master'])('treats %s as the default branch', (branch) => {
    expect(gitPromotionState(branch, true, false)).toEqual({ dirty: false, onDefaultBranch: true });
  });

  it('treats any other branch as not the default', () => {
    expect(gitPromotionState('dor-452-composer-status', true, false).onDefaultBranch).toBe(false);
  });

  it('treats a detached HEAD as not the default branch', () => {
    expect(gitPromotionState('main', true, true).onDefaultBranch).toBe(false);
  });

  it('reads dirtiness as the inverse of clean', () => {
    expect(gitPromotionState('main', false, false).dirty).toBe(true);
  });
});

describe('isPinnable', () => {
  it('allows pinning exactly the Session rows that can appear in the line', () => {
    const pinnable = STATUS_BAR_REGISTRY.filter(isPinnable).map((item) => item.key);
    expect(pinnable).toEqual([
      'cwd',
      'git',
      'runtime',
      'model',
      'context',
      'usage',
      'permission',
      'plan',
    ]);
  });

  it('refuses to pin diagnostics rows', () => {
    // System-managed rows can never be promoted by hand — the invariant that stops
    // pins from quietly becoming ten visibility toggles again.
    expect(isPinnable(getStatusBarItem('connection')!)).toBe(false);
    expect(isPinnable(getStatusBarItem('subagents')!)).toBe(false);
  });

  it('refuses to pin controls or anything excluded from the line', () => {
    expect(isPinnable(getStatusBarItem('polling')!)).toBe(false);
    expect(isPinnable(getStatusBarItem('cache')!)).toBe(false);
  });
});

describe('registry ↔ `ui.statusBar.pins` config schema', () => {
  // Pins are persisted in server config, where the schema enumerates the legal
  // values so a `config_patch` from an agent is validated rather than guessed at.
  // That makes the enum a second source of truth for "what is pinnable", and this
  // is the guard that the two can never drift: rename or remove a pinnable item
  // without touching the schema (and its migration) and this fails.
  it('the pinnable registry items are exactly the schema pin enum', () => {
    const pinnable = STATUS_BAR_REGISTRY.filter(isPinnable)
      .map((item) => item.key)
      .sort();
    expect(pinnable).toEqual([...STATUS_BAR_PIN_KEYS].sort());
  });

  it('every schema pin key resolves to a registry item', () => {
    for (const key of STATUS_BAR_PIN_KEYS) {
      expect(getStatusBarItem(key)).toBeDefined();
    }
  });

  it('nothing pinned is the schema default — the line starts quiet', () => {
    expect(STATUS_BAR_PREFS_DEFAULTS.pins).toEqual([]);
  });
});

describe('getGroupedRegistryItems', () => {
  it('returns Session, Controls, and Diagnostics in that order', () => {
    expect(getGroupedRegistryItems().map((g) => g.group)).toEqual([
      'session',
      'controls',
      'diagnostics',
    ]);
  });

  it('covers every registry item that has a group', () => {
    const grouped = getGroupedRegistryItems()
      .flatMap((g) => g.items.map((i) => i.key))
      .sort();
    const withGroup = STATUS_BAR_REGISTRY.filter((i) => i.group !== null)
      .map((i) => i.key)
      .sort();
    expect(grouped).toEqual(withGroup);
  });

  it('leaves the identity anchor out — it is always there, so it has nothing to configure', () => {
    expect(getStatusBarItem('agent')!.group).toBeNull();
  });
});

describe('STATUS_BAR_REGISTRY — permission severity comes from the mode’s meaning', () => {
  /** A declared mode, with only the semantics under test spelled out. */
  function descriptor(overrides: Partial<PermissionModeDescriptor> = {}): PermissionModeDescriptor {
    return {
      id: 'acceptEdits',
      label: 'Workspace write',
      stop: 'act',
      asks: 'when-risky',
      reach: 'edit',
      promise: 'Edits files on its own.',
      ...overrides,
    };
  }

  it('ranks a keys-handed-over mode top, whatever the runtime calls it', () => {
    // Codex spells it 'Full access'; the ranking reads what it does.
    const ctx = restingContext({
      permissionMode: 'acceptEdits',
      permissionDescriptor: descriptor({ asks: 'never', reach: 'everything', stop: 'autonomy' }),
    });
    expect(severityOf('permission', ctx)).toBe(
      severityOf('permission', restingContext({ permissionMode: 'bypassPermissions' }))
    );
  });

  it('does not rank a never-asking mode top when its reach is bounded', () => {
    // Codex's workspace-write: no approval channel, but it cannot leave the
    // project. Loud in the caption, not the same rank as full autonomy.
    const bounded = severityOf(
      'permission',
      restingContext({
        permissionMode: 'acceptEdits',
        permissionDescriptor: descriptor({ asks: 'never', reach: 'workspace' }),
      })
    );
    const bypass = severityOf(
      'permission',
      restingContext({ permissionMode: 'bypassPermissions' })
    );
    expect(bounded).toBeLessThan(bypass);
  });

  it('falls back to the mode’s name before the capability map arrives', () => {
    const ctx = restingContext({
      permissionMode: 'bypassPermissions',
      permissionDescriptor: null,
    });
    const withProfile = restingContext({
      permissionMode: 'bypassPermissions',
      permissionDescriptor: descriptor({
        id: 'bypassPermissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
      }),
    });
    expect(severityOf('permission', ctx)).toBe(severityOf('permission', withProfile));
  });

  it('reads QUIET off a safe mode whose NAME merely differs from "default" (DOR-820)', () => {
    // test-mode's always-deny is its SAFEST mode — sits at the dial's 'ask'
    // stop — but its id is not literally 'default'. Judging by the name alone
    // (the bug) would have shown PERMISSION_ELEVATED for the safest mode a
    // runtime can offer.
    const ctx = restingContext({
      permissionMode: 'always-deny',
      permissionDescriptor: descriptor({
        id: 'always-deny',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
      }),
    });
    expect(severityOf('permission', ctx)).toBe(
      severityOf('permission', restingContext({ permissionMode: 'default' }))
    );
  });

  it('still reads ELEVATED off the mode name when no descriptor has arrived yet', () => {
    // The fallback path — same shape as the bypass check right above it —
    // still has only the name to go on before the capability map lands.
    const ctx = restingContext({ permissionMode: 'acceptEdits', permissionDescriptor: null });
    expect(severityOf('permission', ctx)).toBeGreaterThan(
      severityOf('permission', restingContext({ permissionMode: 'default' }))
    );
  });

  // `promote` decides whether the item gets a slot AT ALL, and it used to
  // switch on the mode's name exactly like the old `severity` did — the two
  // agreed by accident, not by a shared rule, so a fix to only one of them
  // would have reintroduced the disagreement DOR-820 exists to end. Asserted
  // through `promotedKeys`, the same seam `describe('quiet by default')`
  // uses above, not through `severity` again.
  it('does NOT promote a safe mode whose NAME merely differs from "default"', () => {
    const ctx = restingContext({
      permissionMode: 'always-deny',
      permissionDescriptor: descriptor({
        id: 'always-deny',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
      }),
    });
    expect(promotedKeys(ctx)).not.toContain('permission');
  });

  it('still promotes off the mode name when no descriptor has arrived yet', () => {
    const ctx = restingContext({ permissionMode: 'acceptEdits', permissionDescriptor: null });
    expect(promotedKeys(ctx)).toContain('permission');
  });

  it('promotes a genuinely elevated descriptor mode', () => {
    const ctx = restingContext({
      permissionMode: 'acceptEdits',
      permissionDescriptor: descriptor({ stop: 'act', asks: 'when-risky', reach: 'edit' }),
    });
    expect(promotedKeys(ctx)).toContain('permission');
  });

  // The decision this ticket's review asked to be made explicit: Claude's
  // `plan` descriptor is `stop: 'ask'` — the dial's SAFEST position,
  // read-only by its own promise ("Reads and plans only. Nothing changes
  // until you approve the plan.") — so reading it as QUIET here is not a
  // regression, it is the descriptor telling the truth about a mode the old
  // name-based check only ever flagged because its id was not literally
  // "default". Surfacing "you are planning" is the SEPARATE `plan` item's
  // job (its own `promote`/`severity`, keyed off `ctx.plan`, untouched by
  // this file) — and `status-item-nodes.tsx` omits the Permissions item's
  // rendered node entirely while a way of working holds the session, so the
  // two items never compete for one narrow-bar slot regardless of what this
  // one computes.
  it('reads QUIET for Claude’s plan mode — read-only by its own descriptor, not a risk this item flags', () => {
    const ctx = restingContext({
      permissionMode: 'plan',
      permissionDescriptor: descriptor({
        id: 'plan',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
      }),
    });
    expect(promotedKeys(ctx)).not.toContain('permission');
    expect(severityOf('permission', ctx)).toBe(
      severityOf('permission', restingContext({ permissionMode: 'default' }))
    );
  });
});
