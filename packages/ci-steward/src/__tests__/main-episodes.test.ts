/**
 * Red spells on `main` end when the workflow that failed goes green again,
 * never at a commit that simply did not run it (`mainEpisodes`). The shapes
 * here are the real ones from 2026-08-28..09-24: path-filtered push workflows
 * (desktop-smoke runs on a fraction of commits), two workflows red at once,
 * and old snapshots that only know `red`.
 */
import { describe, expect, it } from 'vitest';
import type { MainCommit } from '../data.ts';
import { mainEpisodes } from '../main-episodes.ts';

const t = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 8, 20, h, m)).toISOString().replace('.000Z', 'Z');

function commit(sha: string, at: string, workflows?: Record<string, boolean>): MainCommit {
  const c: MainCommit = {
    sha,
    at,
    done: at,
    red: workflows ? Object.values(workflows).some(Boolean) : false,
  };
  if (workflows) c.workflows = workflows;
  return c;
}

describe('mainEpisodes', () => {
  it('keeps a spell open across a commit that did not run the failing workflow', () => {
    const eps = mainEpisodes([
      commit('a', t(1), { 'desktop-smoke.yml': true, 'cli-smoke-test.yml': false }),
      // Docs-only: desktop-smoke is path-filtered out, every check that ran is green.
      commit('b', t(2), { 'cli-smoke-test.yml': false, 'db-check.yml': false }),
      commit('c', t(3), { 'desktop-smoke.yml': false, 'cli-smoke-test.yml': false }),
    ]);
    expect(eps).toEqual([
      { sha: 'a', opened: t(1), closed: t(3), workflows: ['desktop-smoke.yml'], unresolved: false },
    ]);
  });

  it('reads the same commits the old way when they carry no per-workflow results', () => {
    const legacy = (sha: string, at: string, red: boolean): MainCommit => ({
      sha,
      at,
      done: at,
      red,
    });
    // The rule this replaces: the first all-green commit closes the spell.
    expect(
      mainEpisodes([legacy('a', t(1), true), legacy('b', t(2), false), legacy('c', t(3), true)])
    ).toEqual([
      { sha: 'a', opened: t(1), closed: t(2), workflows: ['*'], unresolved: false },
      { sha: 'c', opened: t(3), closed: null, workflows: ['*'], unresolved: false },
    ]);
  });

  it('counts two workflows red at once as one spell, closed when the last goes green', () => {
    const eps = mainEpisodes([
      commit('a', t(1), { 'scripts-test.yml': true, 'db-check.yml': false }),
      commit('b', t(2), { 'scripts-test.yml': true, 'cli-smoke-test.yml': true }),
      commit('c', t(3), { 'scripts-test.yml': false, 'cli-smoke-test.yml': true }),
      commit('d', t(4), { 'cli-smoke-test.yml': false }),
    ]);
    expect(eps).toEqual([
      {
        sha: 'a',
        opened: t(1),
        closed: t(4),
        workflows: ['cli-smoke-test.yml', 'scripts-test.yml'],
        unresolved: false,
      },
    ]);
  });

  it('ignores a cancelled or skipped run (absent from the map), so it cannot close a spell', () => {
    const eps = mainEpisodes([
      commit('a', t(1), { 'scripts-test.yml': true }),
      commit('b', t(2), {}),
      commit('c', t(3), { 'scripts-test.yml': false }),
    ]);
    expect(eps.map((e) => [e.sha, e.closed])).toEqual([['a', t(3)]]);
  });

  it('drops a red workflow that stops reporting for 7 days, so a retired sensor cannot hold main red forever', () => {
    const day = (d: number) =>
      new Date(Date.UTC(2026, 8, 1 + d, 12)).toISOString().replace('.000Z', 'Z');
    const commits = [commit('a', day(0), { 'typecheck.yml': true, 'db-check.yml': false })];
    for (let d = 1; d <= 9; d += 1)
      commits.push(commit(`g${d}`, day(d), { 'db-check.yml': false }));
    const eps = mainEpisodes(commits);
    // Day 7 is exactly 7 days after the last red report: still inside. Day 8
    // notices the silence, and the spell ends back at that last red report,
    // unresolved: nothing ever showed main restored, so it has no restore time.
    expect(eps).toEqual([
      { sha: 'a', opened: day(0), closed: day(0), workflows: ['typecheck.yml'], unresolved: true },
    ]);
  });

  it('never lets a commit with no result (every run cancelled) close an old-format spell', () => {
    const eps = mainEpisodes([
      { sha: 'a', at: t(1), done: t(1), red: true },
      commit('b', t(2), {}),
    ]);
    expect(eps.map((e) => [e.sha, e.closed])).toEqual([['a', null]]);
  });

  it('closes a spell an old-format commit opened at the first green new-format commit', () => {
    const eps = mainEpisodes([
      { sha: 'a', at: t(1), done: t(1), red: true },
      commit('b', t(2), { 'db-check.yml': false }),
    ]);
    expect(eps.map((e) => [e.sha, e.closed])).toEqual([['a', t(2)]]);
  });

  it('returns nothing for an all-green run', () => {
    expect(mainEpisodes([commit('a', t(1), { 'db-check.yml': false })])).toEqual([]);
  });

  it('counts an unresolved spell in main-green but gives it no restore time', async () => {
    const { computeSlos } = await import('../slo.ts');
    const { emptySnapshot } = await import('../data.ts');
    const day = (d: number) =>
      new Date(Date.UTC(2026, 8, 1 + d, 12)).toISOString().replace('.000Z', 'Z');
    const snap = emptySnapshot('2026-09-01', 'x', 700);
    snap.main = [commit('a', day(0), { 'typecheck.yml': true })];
    for (let d = 1; d <= 9; d += 1)
      snap.main.push(commit(`g${d}`, day(d), { 'db-check.yml': false }));
    const slo = {
      id: 'main-green',
      kind: 'quality' as const,
      title: 't',
      definition: {
        event_source: 'x',
        population: 'x',
        exclusions: [],
        aggregation: 'x',
        window: 'x',
        min_n: 1,
        fixture: 'x',
      },
      today: 'x',
      floor: null,
      objective: [{ stat: 'red_episodes', op: '<=' as const, value: 1, unit: 'count' }],
      path: 'x',
    };
    const [r] = computeSlos(
      { slos: [slo] },
      {},
      {
        snapshots: [snap],
        local: [],
        toolCeilingSeconds: 600,
        from: '2026-09-01',
        to: '2026-09-01',
      }
    );
    expect(r!.stats).toEqual({ red_episodes: 1 });
  });
});
