import { describe, it, expect } from 'vitest';
import { describeRules } from '../evaluate-smart-group';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

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
