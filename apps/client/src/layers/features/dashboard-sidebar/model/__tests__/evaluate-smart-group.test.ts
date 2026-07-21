import { describe, it, expect } from 'vitest';
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import {
  evaluateSmartGroup,
  describeRules,
  type SmartGroupCandidate,
} from '../evaluate-smart-group';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function candidate(overrides: Partial<SmartGroupCandidate> = {}): SmartGroupCandidate {
  return {
    projectPath: '/Users/dorian/work/alpha',
    runtime: 'claude-code',
    namespace: 'default',
    attention: 'active',
    lastActivityAt: NOW - HOUR / 2,
    ...overrides,
  };
}

describe('evaluateSmartGroup', () => {
  describe('single predicates in isolation', () => {
    it('runtimes: matches any listed runtime (OR within field)', () => {
      const rules: SmartGroupRules = { runtimes: ['codex', 'opencode'] };
      const candidates = [
        candidate({ projectPath: '/a', runtime: 'codex' }),
        candidate({ projectPath: '/b', runtime: 'opencode' }),
        candidate({ projectPath: '/c', runtime: 'claude-code' }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a', '/b']);
    });

    it('namespaces: matches any listed namespace, never a null namespace', () => {
      const rules: SmartGroupRules = { namespaces: ['team-a'] };
      const candidates = [
        candidate({ projectPath: '/a', namespace: 'team-a' }),
        candidate({ projectPath: '/b', namespace: 'team-b' }),
        candidate({ projectPath: '/c', namespace: null }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a']);
    });

    it('statuses: matches any listed attention state (OR within field)', () => {
      const rules: SmartGroupRules = { statuses: ['needs-attention', 'active'] };
      const candidates = [
        candidate({ projectPath: '/a', attention: 'needs-attention' }),
        candidate({ projectPath: '/b', attention: 'active' }),
        candidate({ projectPath: '/c', attention: 'idle' }),
        candidate({ projectPath: '/d', attention: 'inactive' }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a', '/b']);
    });

    it('lastActiveWithinMs: matches activity within the window', () => {
      const rules: SmartGroupRules = { lastActiveWithinMs: HOUR };
      const candidates = [
        candidate({ projectPath: '/a', lastActivityAt: NOW - HOUR / 2 }),
        candidate({ projectPath: '/b', lastActivityAt: NOW - 2 * HOUR }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a']);
    });

    it('lastActiveWithinMs: never matches a null lastActivityAt', () => {
      const rules: SmartGroupRules = { lastActiveWithinMs: WEEK };
      const candidates = [candidate({ projectPath: '/a', lastActivityAt: null })];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual([]);
    });

    it('lastActiveWithinMs boundary: exactly the window is inclusive', () => {
      const rules: SmartGroupRules = { lastActiveWithinMs: HOUR };
      const atBoundary = candidate({ projectPath: '/a', lastActivityAt: NOW - HOUR });
      const pastBoundary = candidate({ projectPath: '/b', lastActivityAt: NOW - HOUR - 1 });
      expect(evaluateSmartGroup(rules, [atBoundary, pastBoundary], NOW)).toEqual(['/a']);
    });

    it('pathPrefix: matches a plain startsWith', () => {
      const rules: SmartGroupRules = { pathPrefix: '/Users/dorian/work' };
      const candidates = [
        candidate({ projectPath: '/Users/dorian/work/alpha' }),
        candidate({ projectPath: '/Users/dorian/personal/beta' }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/Users/dorian/work/alpha']);
    });
  });

  describe('AND across fields', () => {
    it('requires every present field to pass, not just one', () => {
      const rules: SmartGroupRules = { runtimes: ['codex'], statuses: ['active'] };
      const candidates = [
        candidate({ projectPath: '/a', runtime: 'codex', attention: 'active' }),
        candidate({ projectPath: '/b', runtime: 'codex', attention: 'idle' }),
        candidate({ projectPath: '/c', runtime: 'claude-code', attention: 'active' }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a']);
    });

    it('an absent field imposes no constraint', () => {
      const rules: SmartGroupRules = { runtimes: ['codex'] };
      const candidates = [
        candidate({ projectPath: '/a', runtime: 'codex', namespace: 'x', attention: 'idle' }),
      ];
      expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/a']);
    });
  });

  it('preserves candidate input order in the result', () => {
    const rules: SmartGroupRules = { statuses: ['active', 'idle'] };
    const candidates = [
      candidate({ projectPath: '/z', attention: 'active' }),
      candidate({ projectPath: '/a', attention: 'idle' }),
      candidate({ projectPath: '/m', attention: 'needs-attention' }),
    ];
    expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual(['/z', '/a']);
  });

  it('is deterministic on identical input', () => {
    const rules: SmartGroupRules = { runtimes: ['codex'], lastActiveWithinMs: DAY };
    const candidates = [candidate({ runtime: 'codex', lastActivityAt: NOW - HOUR })];
    const first = evaluateSmartGroup(rules, candidates, NOW);
    const second = evaluateSmartGroup(rules, candidates, NOW);
    expect(first).toEqual(second);
  });

  it('returns an empty array when nothing matches (the "0 matching" case)', () => {
    const rules: SmartGroupRules = { runtimes: ['codex'] };
    const candidates = [candidate({ runtime: 'claude-code' })];
    expect(evaluateSmartGroup(rules, candidates, NOW)).toEqual([]);
  });
});

describe('describeRules', () => {
  it('describes a single runtime', () => {
    expect(describeRules({ runtimes: ['codex'] })).toBe('Codex');
  });

  it('describes multiple runtimes with English "or" joining', () => {
    expect(describeRules({ runtimes: ['codex', 'opencode'] })).toBe('Codex or OpenCode');
  });

  it('describes three or more values with an Oxford comma', () => {
    expect(describeRules({ statuses: ['active', 'idle', 'inactive'] })).toBe(
      'active, idle, or inactive'
    );
  });

  it('describes namespaces', () => {
    expect(describeRules({ namespaces: ['team-a'] })).toBe('in team-a');
    expect(describeRules({ namespaces: ['team-a', 'team-b'] })).toBe('in team-a or team-b');
  });

  it('describes statuses with human labels', () => {
    expect(describeRules({ statuses: ['needs-attention'] })).toBe('needs attention');
  });

  it('describes the three activity-window presets in plain language', () => {
    expect(describeRules({ lastActiveWithinMs: HOUR })).toBe('active in the last hour');
    expect(describeRules({ lastActiveWithinMs: DAY })).toBe('active in the last day');
    expect(describeRules({ lastActiveWithinMs: WEEK })).toBe('active in the last week');
  });

  it('describes an arbitrary activity window outside the presets', () => {
    expect(describeRules({ lastActiveWithinMs: 2 * DAY })).toBe('active in the last 2 days');
    expect(describeRules({ lastActiveWithinMs: 30 * 60 * 1000 })).toBe(
      'active in the last 0.5 hours'
    );
  });

  it('describes a path prefix', () => {
    expect(describeRules({ pathPrefix: '/Users/dorian/work' })).toBe('under /Users/dorian/work');
  });

  it('joins every present field with the same separator, in form order', () => {
    expect(
      describeRules({
        runtimes: ['codex'],
        statuses: ['needs-attention', 'active'],
        lastActiveWithinMs: HOUR,
      })
    ).toBe('Codex · needs attention or active · active in the last hour');
  });

  it("the spec's own example reads as documented", () => {
    expect(describeRules({ runtimes: ['codex'], lastActiveWithinMs: HOUR })).toBe(
      'Codex · active in the last hour'
    );
  });
});
