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
      { sha: 'a', opened: t(1), closed: t(3), workflows: ['desktop-smoke.yml'] },
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
      { sha: 'a', opened: t(1), closed: t(2), workflows: ['*'] },
      { sha: 'c', opened: t(3), closed: null, workflows: ['*'] },
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
    expect(eps).toHaveLength(1);
    // Day 7 is exactly 7 days after the last red report: still inside. Day 8 is past it.
    expect(eps[0]!.closed).toBe(day(8));
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
});
