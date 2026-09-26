/**
 * Pins scripts/origin-branch-janitor.ts, the `worktree-janitor.sh --origin` pass.
 * Its --fix deletes branches on origin, so the keep side is pinned hardest: every
 * skip and report case is otherwise a SAFE branch with one fact flipped, and the
 * driver tests prove a refused input deletes nothing. git and gh are a stub that
 * answers by command line; nothing here touches a real remote.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classify,
  main,
  type BranchFacts,
  type Exec,
  type PrRecord,
} from '../origin-branch-janitor.ts';

const SHA = 'a'.repeat(40);

/** A branch that is SAFE because its tip is in main; each case flips one fact. */
function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    name: 'codex/finished-attempt',
    sha: SHA,
    defaultBranch: 'main',
    prs: [],
    isBaseOfOpenPr: false,
    hasWorktree: false,
    ancestorOfDefault: true,
    tipAgeHours: 200,
    idleHours: 24,
    ...over,
  };
}

const pr = (state: PrRecord['state'], headRefOid = SHA): PrRecord => ({
  number: 1,
  headRefName: 'codex/finished-attempt',
  headRefOid,
  baseRefName: 'main',
  state,
});

describe('classify', () => {
  it('SAFE when the tip is already in main', () => {
    expect(classify(facts())).toEqual({ kind: 'safe', reason: 'in-main' });
  });

  it('SAFE when a merged PR had exactly this tip', () => {
    const v = classify(facts({ ancestorOfDefault: false, prs: [pr('MERGED')] }));
    expect(v).toEqual({ kind: 'safe', reason: 'merged-pr' });
  });

  it.each([
    'main',
    'ci-steward-data',
    'ci-steward-data/2026-W39',
    'release/v0.84',
    'release-0.84',
    'releases/next',
    'gh-readonly-queue/main/pr-1-abc',
  ])('skips protected %s even when its tip is in main', (name) => {
    expect(classify(facts({ name }))).toEqual({ kind: 'skip', reason: 'protected' });
  });

  it('does not protect a name that merely starts with "release"', () => {
    expect(classify(facts({ name: 'released-notes-draft' })).kind).toBe('safe');
  });

  it('skips a branch with an open PR, even one whose tip is in main', () => {
    const v = classify(facts({ prs: [pr('MERGED'), pr('OPEN')] }));
    expect(v).toEqual({ kind: 'skip', reason: 'pr-open' });
  });

  it('skips a branch an open PR targets as its base, even one whose tip is in main', () => {
    expect(classify(facts({ isBaseOfOpenPr: true }))).toEqual({
      kind: 'skip',
      reason: 'base-of-open-pr',
    });
  });

  it('skips a branch checked out in a worktree here', () => {
    expect(classify(facts({ hasWorktree: true })).reason).toBe('has-worktree');
  });

  it('skips a branch whose tip is younger than the idle threshold', () => {
    expect(classify(facts({ tipAgeHours: 3 }))).toEqual({ kind: 'skip', reason: 'recent' });
  });

  it('reports, never deletes, a branch whose tip age is unknown', () => {
    expect(classify(facts({ tipAgeHours: null }))).toEqual({
      kind: 'report',
      reason: 'tip-age-unknown',
    });
  });

  it.each<[string, Partial<BranchFacts>, string]>([
    ['no PR and work not in main', { ancestorOfDefault: false }, 'no-pr'],
    ['ancestry check errored', { ancestorOfDefault: null }, 'ancestry-unknown'],
    [
      'commits pushed after its PR merged',
      { ancestorOfDefault: false, prs: [pr('MERGED', 'b'.repeat(40))] },
      'commits-after-merge',
    ],
    ['a closed, unmerged PR', { ancestorOfDefault: false, prs: [pr('CLOSED')] }, 'closed-pr'],
  ])('reports %s', (_label, over, reason) => {
    expect(classify(facts(over))).toEqual({ kind: 'report', reason });
  });
});

/** A fake git + gh. `ancestors` are the SHAs in main; `fail` names a failing command. */
function stub(opts: {
  heads: Record<string, string>;
  prs?: PrRecord[] | 'fail';
  ancestors?: string[];
  worktrees?: string[];
  fail?: 'fetch' | 'ls-remote';
  pushFails?: string[];
  /** Tip commit age in hours by SHA; 240 (10 days) when absent. */
  tipAgeHours?: Record<string, number>;
}) {
  const pushes: string[] = [];
  const now = Date.parse('2026-09-25T12:00:00Z');
  const exec: Exec = (cmd, args) => {
    const ok = (stdout = '') => ({ status: 0, stdout });
    const line = [cmd, ...args].join(' ');
    if (cmd === 'gh') {
      return opts.prs === 'fail' ? { status: 1, stdout: '' } : ok(JSON.stringify(opts.prs ?? []));
    }
    if (args[0] === 'fetch') return opts.fail === 'fetch' ? { status: 128, stdout: '' } : ok();
    if (args[0] === 'symbolic-ref') return ok('origin/main\n');
    if (args[0] === 'rev-parse') return ok(`${'f'.repeat(40)}\n`);
    if (args[0] === 'ls-remote') {
      if (opts.fail === 'ls-remote') return { status: 128, stdout: '' };
      return ok(
        Object.entries(opts.heads)
          .map(([name, sha]) => `${sha}\trefs/heads/${name}`)
          .join('\n')
      );
    }
    if (args[0] === 'worktree') {
      return ok(
        (opts.worktrees ?? []).map((b) => `worktree /x/${b}\nbranch refs/heads/${b}\n`).join('\n')
      );
    }
    if (args[0] === 'merge-base') {
      return { status: (opts.ancestors ?? []).includes(args[2] ?? '') ? 0 : 1, stdout: '' };
    }
    if (args[0] === 'log') {
      const hours = opts.tipAgeHours?.[args.at(-1) ?? ''] ?? 240;
      return ok(`${Math.floor(now / 1000) - hours * 3600}\n`);
    }
    if (args[0] === 'push') {
      pushes.push(line);
      const target = args.at(-1) ?? '';
      const failing = (opts.pushFails ?? []).some((b) => target === `:refs/heads/${b}`);
      return { status: failing ? 1 : 0, stdout: '' };
    }
    throw new Error(`unexpected command: ${line}`);
  };
  return { exec, pushes, now };
}

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runMain(s: ReturnType<typeof stub>, argv: string[], env: Record<string, string> = {}) {
  home = mkdtempSync(join(tmpdir(), 'origin-janitor-'));
  const out: string[] = [];
  const code = main({
    argv,
    exec: s.exec,
    log: (l) => out.push(l),
    nowMs: s.now,
    env: { DORK_HOME: home, ...env },
  });
  return { code, out: out.join('\n') };
}

const IN_MAIN = '1'.repeat(40);
const UNSHIPPED = '2'.repeat(40);
const OPEN_TIP = '3'.repeat(40);
const FRESH = '4'.repeat(40);

describe('main', () => {
  // Every branch but codex/shipped is kept for exactly one reason.
  const heads = {
    main: IN_MAIN,
    'ci-steward-data': IN_MAIN,
    'codex/shipped': IN_MAIN,
    'codex/unshipped': UNSHIPPED,
    'codex/stack-base': IN_MAIN,
    'codex/fresh': FRESH,
    'feat/in-review': OPEN_TIP,
    'feat/mine': IN_MAIN,
  };
  const prs: PrRecord[] = [
    {
      number: 7,
      headRefName: 'feat/in-review',
      headRefOid: OPEN_TIP,
      baseRefName: 'codex/stack-base',
      state: 'OPEN',
    },
  ];
  const ancestors = [IN_MAIN, OPEN_TIP, FRESH];
  const tipAgeHours = { [FRESH]: 2 };
  const world = { heads, prs, ancestors, tipAgeHours, worktrees: ['feat/mine'] };

  it('report mode pushes nothing', () => {
    const s = stub(world);
    const { code, out } = runMain(s, []);
    expect(code).toBe(0);
    expect(s.pushes).toEqual([]);
    expect(out).toContain('1 safe, 1 to look at');
  });

  it('an empty or zero idle setting keeps the 24-hour guard', () => {
    for (const value of ['', '0', '-5']) {
      const s = stub(world);
      runMain(s, ['--fix'], { DORKOS_JANITOR_IDLE_HOURS: value });
      expect(s.pushes.some((p) => p.includes('codex/fresh'))).toBe(false);
    }
  });

  it('--fix deletes only the SAFE branch, under a lease on the judged tip', () => {
    const s = stub(world);
    const { code } = runMain(s, ['--fix']);
    expect(code).toBe(0);
    expect(s.pushes).toEqual([
      `git push --quiet --force-with-lease=refs/heads/codex/shipped:${IN_MAIN} origin :refs/heads/codex/shipped`,
    ]);
    expect(readFileSync(join(home ?? '', 'worktree-janitor.log'), 'utf8')).toContain(
      `${IN_MAIN}\tcodex/shipped`
    );
  });

  it.each([
    ['the PR list fails', { prs: 'fail' as const }],
    ['fetch fails', { fail: 'fetch' as const }],
    ['origin cannot be listed', { fail: 'ls-remote' as const }],
  ])('refuses and deletes nothing when %s', (_label, over) => {
    const s = stub({ heads, prs, ancestors, ...over });
    const { code, out } = runMain(s, ['--fix']);
    expect(code).toBe(2);
    expect(s.pushes).toEqual([]);
    expect(out).toContain('refused');
  });

  it('refuses a PR list that may be truncated', () => {
    const many: PrRecord[] = Array.from({ length: 5000 }, (_, i) => ({
      number: i,
      headRefName: `x/${i}`,
      headRefOid: SHA,
      baseRefName: 'main',
      state: 'MERGED',
    }));
    const s = stub({ heads, prs: many, ancestors });
    expect(runMain(s, ['--fix']).code).toBe(2);
    expect(s.pushes).toEqual([]);
  });

  it('exits 1 when a deletion fails', () => {
    const s = stub({ heads, prs, ancestors, pushFails: ['codex/shipped'] });
    const { code, out } = runMain(s, ['--fix']);
    expect(code).toBe(1);
    expect(out).toContain('FAILED  codex/shipped');
  });

  it('rejects --fix with --json', () => {
    const s = stub({ heads });
    expect(runMain(s, ['--fix', '--json']).code).toBe(2);
    expect(s.pushes).toEqual([]);
  });
});
