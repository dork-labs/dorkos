import { describe, it, expect } from 'vitest';
import { sortAgentPaths, type SortAgentsContext } from '../sort-agents';

const displayNames: Record<string, string> = {
  '/p/zebra': 'Zebra',
  '/p/alpha': 'Alpha',
  '/p/middle': 'Middle',
};

const agentActivity: Record<string, string> = {
  '/p/zebra': '2026-07-16T10:00:00.000Z',
  '/p/alpha': '2026-07-16T12:00:00.000Z',
  // /p/middle intentionally absent (no activity)
};

const ctx: SortAgentsContext = { displayNames, agentActivity };

describe('sortAgentPaths', () => {
  it('manual returns input order unchanged', () => {
    const input = ['/p/zebra', '/p/alpha', '/p/middle'];
    expect(sortAgentPaths(input, 'manual', ctx)).toEqual(input);
  });

  it('name sorts alphabetically by disambiguated display name', () => {
    const input = ['/p/zebra', '/p/alpha', '/p/middle'];
    expect(sortAgentPaths(input, 'name', ctx)).toEqual(['/p/alpha', '/p/middle', '/p/zebra']);
  });

  it('falls back to the path when a display name is missing', () => {
    const input = ['/p/b', '/p/a'];
    expect(sortAgentPaths(input, 'name', { displayNames: {}, agentActivity: {} })).toEqual([
      '/p/a',
      '/p/b',
    ]);
  });

  it('recent sorts by agentActivity descending', () => {
    const input = ['/p/zebra', '/p/alpha'];
    // alpha (12:00) is more recent than zebra (10:00)
    expect(sortAgentPaths(input, 'recent', ctx)).toEqual(['/p/alpha', '/p/zebra']);
  });

  it('recent sorts paths with no activity after paths that have timestamps', () => {
    const input = ['/p/middle', '/p/zebra', '/p/alpha'];
    expect(sortAgentPaths(input, 'recent', ctx)).toEqual(['/p/alpha', '/p/zebra', '/p/middle']);
  });

  it('recent breaks equal timestamps by display name', () => {
    const activity = {
      '/p/zebra': '2026-07-16T10:00:00.000Z',
      '/p/alpha': '2026-07-16T10:00:00.000Z',
    };
    const input = ['/p/zebra', '/p/alpha'];
    expect(sortAgentPaths(input, 'recent', { displayNames, agentActivity: activity })).toEqual([
      '/p/alpha',
      '/p/zebra',
    ]);
  });

  it('recent breaks both-missing timestamps by display name', () => {
    const input = ['/p/zebra', '/p/alpha', '/p/middle'];
    expect(sortAgentPaths(input, 'recent', { displayNames, agentActivity: {} })).toEqual([
      '/p/alpha',
      '/p/middle',
      '/p/zebra',
    ]);
  });

  it('never mutates the input array and is deterministic', () => {
    const input = ['/p/zebra', '/p/alpha', '/p/middle'];
    const copy = [...input];
    const out = sortAgentPaths(input, 'name', ctx);
    expect(input).toEqual(copy); // input untouched
    expect(out).not.toBe(input); // new array
    expect(sortAgentPaths(input, 'name', ctx)).toEqual(out); // deterministic
  });
});
