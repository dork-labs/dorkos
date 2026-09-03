import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { alwaysAllowScopeOf, suggestionDestinations } from '../always-allow-scope.js';
import { logger } from '../../../../../lib/logger.js';

/** A tool rule bound for one settings destination — the shape a real card carries. */
function rule(destination: PermissionUpdate['destination']): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
    behavior: 'allow',
    destination,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('alwaysAllowScopeOf', () => {
  it('says nothing when there is no "Always Allow" to describe', () => {
    // No suggestions means no button, and a scope for a button nobody can press
    // would put a promise on a card that cannot keep it.
    expect(alwaysAllowScopeOf(undefined)).toBeUndefined();
    expect(alwaysAllowScopeOf([])).toBeUndefined();
  });

  it('reads a session-lifetime grant as "session"', () => {
    expect(
      alwaysAllowScopeOf([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    ).toBe('session');
    expect(alwaysAllowScopeOf([rule('cliArg')])).toBe('session');
  });

  it('reads both project settings files as "project"', () => {
    expect(alwaysAllowScopeOf([rule('projectSettings')])).toBe('project');
    expect(alwaysAllowScopeOf([rule('localSettings')])).toBe('project');
  });

  it('reads the operator settings file as "user"', () => {
    expect(alwaysAllowScopeOf([rule('userSettings')])).toBe('user');
  });

  it('describes a mixed batch by its WIDEST destination', () => {
    // The regression this exists for: one click forwards the whole array, so a
    // batch that also writes ~/.claude/settings.json reaches every Claude
    // session — and describing it by its first, narrowest member is exactly the
    // silence DOR-1462 is about.
    expect(
      alwaysAllowScopeOf([
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        rule('userSettings'),
      ])
    ).toBe('user');
    expect(alwaysAllowScopeOf([rule('session'), rule('localSettings')])).toBe('project');
  });

  it('reads a destination it does not recognise as the widest, and says so', () => {
    // An SDK that grows a destination must not silently narrow the card's
    // promise: over-claiming costs a moment of caution, under-claiming moves a
    // global default unannounced.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const unknown = {
      ...rule('session'),
      destination: 'policySettings',
    } as unknown as PermissionUpdate;

    expect(alwaysAllowScopeOf([unknown])).toBe('user');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown permission destination'), {
      destination: 'policySettings',
      type: 'addRules',
    });
  });
});

describe('suggestionDestinations', () => {
  it('lists the raw SDK destinations, in order, for the log', () => {
    // Raw rather than reduced on purpose: the log is what answers, after a week
    // of real cards, which destinations actually turn up.
    expect(suggestionDestinations([rule('session'), rule('userSettings')])).toEqual([
      'session',
      'userSettings',
    ]);
    expect(suggestionDestinations(undefined)).toEqual([]);
  });
});
