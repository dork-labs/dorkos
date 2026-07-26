import { describe, it, expect } from 'vitest';
import { parseArgs, planAgents, VOCABULARIES } from '../plan.js';

describe('planAgents', () => {
  it('puts every agent in one tree for arm 1', () => {
    const agents = planAgents(1, 6);
    expect(agents.map((a) => a.tree)).toEqual(['a', 'a', 'a', 'a', 'a', 'a']);
    expect(agents.map((a) => a.vocab)).toEqual([...VOCABULARIES]);
  });

  it('splits agents across two trees for the arm 2 control', () => {
    const agents = planAgents(2, 6);
    expect(agents.map((a) => a.tree)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    expect(agents.filter((a) => a.tree === 'a')).toHaveLength(3);
  });

  it('gives every agent a distinct vocabulary', () => {
    const agents = planAgents(2, 6);
    expect(new Set(agents.map((a) => a.vocab)).size).toBe(6);
  });

  it('refuses more agents than there are distinct vocabularies', () => {
    expect(() => planAgents(1, VOCABULARIES.length + 1)).toThrow(/at most 6 agents/);
  });
});

describe('parseArgs', () => {
  it('requires an arm', () => {
    expect(() => parseArgs([])).toThrow(/--arm/);
  });

  it('rejects an unknown arm', () => {
    expect(() => parseArgs(['--arm', '4'])).toThrow(/must be 1, 2, or 3/);
  });

  it('defaults arm 1 to six agents in one tree', () => {
    const plan = parseArgs(['--arm', '1'])!;
    expect(plan.agents).toHaveLength(6);
    expect(plan.trees).toEqual(['a']);
    expect(plan.testMode).toBe(true);
  });

  it('provisions two trees for arms 2 and 3', () => {
    expect(parseArgs(['--arm', '2'])!.trees).toEqual(['a', 'b']);
    expect(parseArgs(['--arm', '3'])!.trees).toEqual(['a', 'b']);
  });

  it('marks arm 3 as the real-runtime arm', () => {
    const plan = parseArgs(['--arm', '3'])!;
    expect(plan.testMode).toBe(false);
    expect(plan.runtime).toBe('claude-code');
  });

  it('shrinks the run under --smoke', () => {
    const plan = parseArgs(['--arm', '1', '--smoke'])!;
    expect(plan.agents).toHaveLength(2);
    expect(plan.durationMs).toBeLessThan(10_000);
  });

  it('lets explicit flags win over --smoke defaults', () => {
    const plan = parseArgs(['--arm', '1', '--smoke', '--duration', '9000', '--agents', '3'])!;
    expect(plan.durationMs).toBe(9000);
    expect(plan.agents).toHaveLength(3);
  });

  it('returns null for --help', () => {
    expect(parseArgs(['--help'])).toBeNull();
  });

  it('rejects a flag with a missing or non-numeric value', () => {
    expect(() => parseArgs(['--arm', '1', '--duration'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--arm', '1', '--duration', 'soon'])).toThrow(/positive integer/);
  });
});
