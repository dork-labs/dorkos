/**
 * merge-behavior.test.ts — empirical merge experiments for spec #271 / DOR-184.
 *
 * This is the validation gate the whole "prevent multi-agent merge conflicts"
 * spec rests on. Each test spins up a REAL throwaway git repo in the OS temp dir,
 * creates two divergent branches, merges them with git's DEFAULT driver (the one
 * that also runs on GitHub's server-side merge), and asserts whether the merge
 * conflicts. It maps the design space with honest negative controls so evidence,
 * not assumption, drives the conventions we adopt.
 *
 * Run directly (no workspace / Vitest):
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/merge-behavior.test.ts
 *
 * Findings (see the assertions):
 *  - Manifest as {nextNumber, [array]}: concurrent adds ALWAYS conflict.
 *  - Manifest as id-keyed object: adds in different key regions auto-merge;
 *    adds that land in the SAME gap still conflict (union-resolvable, no data loss).
 *  - Numbered filenames collide (add/add) when two branches pick the same number+slug;
 *    timestamp-id filenames never collide.
 *  - CHANGELOG single [Unreleased] block: concurrent same-section appends conflict
 *    under the default driver; merge=union resolves them locally; a sentinel anchor
 *    alone does NOT (both still insert at the same line); one-file-per-entry never
 *    conflicts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}
function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}
function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
function commitAll(dir: string, msg: string): void {
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', msg]);
}

interface Scenario {
  base: (dir: string) => void;
  a: (dir: string) => void;
  b: (dir: string) => void;
}
interface MergeResult {
  conflicted: boolean;
  read: (rel: string) => string;
  cleanup: () => void;
}

/** Build base, branch two edits off it, merge branch-b into branch-a, report conflict + tree. */
function twoWayMerge(scn: Scenario): MergeResult {
  const dir = mkdtempSync(join(tmpdir(), 'merge-behavior-'));
  gitOk(dir, ['init', '-q', '-b', 'main']);
  gitOk(dir, ['config', 'user.email', 't@t.com']);
  gitOk(dir, ['config', 'user.name', 'T']);
  gitOk(dir, ['config', 'commit.gpgsign', 'false']);

  scn.base(dir);
  commitAll(dir, 'base');
  gitOk(dir, ['checkout', '-q', '-b', 'branch-a']);
  scn.a(dir);
  commitAll(dir, 'a');
  gitOk(dir, ['checkout', '-q', 'main']);
  gitOk(dir, ['checkout', '-q', '-b', 'branch-b']);
  scn.b(dir);
  commitAll(dir, 'b');
  gitOk(dir, ['checkout', '-q', 'branch-a']);

  const m = git(dir, ['merge', '--no-edit', 'branch-b']);
  return {
    conflicted: m.status !== 0,
    read: (rel: string) => readFileSync(join(dir, rel), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Manifest shape ──────────────────────────────────────────────────────────

const arrayManifest = (nextNumber: number, entries: object[]) =>
  JSON.stringify({ version: 1, nextNumber, decisions: entries }, null, 2) + '\n';

test('NEGATIVE CONTROL: array + nextNumber manifest — concurrent adds conflict', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'manifest.json', arrayManifest(3, [{ number: 2 }, { number: 1 }])),
    // both branches read nextNumber=3, allocate 3, unshift, bump to 4
    a: (d) =>
      write(
        d,
        'manifest.json',
        arrayManifest(4, [{ number: 3, slug: 'a' }, { number: 2 }, { number: 1 }])
      ),
    b: (d) =>
      write(
        d,
        'manifest.json',
        arrayManifest(4, [{ number: 3, slug: 'b' }, { number: 2 }, { number: 1 }])
      ),
  });
  try {
    assert.equal(
      r.conflicted,
      true,
      'the current array+counter scheme must conflict (the pain we are removing)'
    );
  } finally {
    r.cleanup();
  }
});

const objManifest = (decisions: Record<string, object>) =>
  JSON.stringify({ version: 2, decisions }, null, 2) + '\n';

test('id-keyed manifest — adds in different key regions auto-merge cleanly', () => {
  const base = { '260101-000000': { slug: 'jan' }, '260601-000000': { slug: 'jun' } };
  const r = twoWayMerge({
    base: (d) => write(d, 'manifest.json', objManifest(base)),
    // a inserts into the tail region (after jun); b inserts into the middle gap (jan..jun)
    a: (d) => write(d, 'manifest.json', objManifest({ ...base, '260703-000000': { slug: 'a' } })),
    b: (d) =>
      write(
        d,
        'manifest.json',
        objManifest({
          '260101-000000': base['260101-000000'],
          '260301-000000': { slug: 'b' },
          '260601-000000': base['260601-000000'],
        })
      ),
  });
  try {
    assert.equal(
      r.conflicted,
      false,
      'distinct-region key adds should auto-merge with the default driver'
    );
    const merged = JSON.parse(r.read('manifest.json'));
    assert.ok(
      merged.decisions['260703-000000'] && merged.decisions['260301-000000'],
      'both new keys present'
    );
    assert.equal(merged.nextNumber, undefined, 'no shared counter remains');
  } finally {
    r.cleanup();
  }
});

test('HONEST RESIDUAL: id-keyed manifest — adds landing in the SAME gap still conflict (union-resolvable)', () => {
  const base = { '260101-000000': { slug: 'jan' } };
  const r = twoWayMerge({
    base: (d) => write(d, 'manifest.json', objManifest(base)),
    a: (d) => write(d, 'manifest.json', objManifest({ ...base, '260703-081200': { slug: 'a' } })),
    b: (d) => write(d, 'manifest.json', objManifest({ ...base, '260703-081500': { slug: 'b' } })),
  });
  try {
    // Documents why a committed manifest is not a hard guarantee: two adds in the
    // same tail region still conflict. It is now a trivial keep-both conflict (no
    // counter, no data loss) — and motivates the generate-from-frontmatter follow-up.
    assert.equal(r.conflicted, true, 'same-region adds still conflict (documented residual)');
  } finally {
    r.cleanup();
  }
});

// ── Per-entry files (the ADR/spec markdown) ──────────────────────────────────

test('NEGATIVE CONTROL: numbered filenames collide (add/add) when two branches pick the same number+slug', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'decisions/.gitkeep', ''),
    a: (d) => write(d, 'decisions/0300-topic.md', '# 300\nfrom a\n'),
    b: (d) => write(d, 'decisions/0300-topic.md', '# 300\nfrom b\n'),
  });
  try {
    assert.equal(
      r.conflicted,
      true,
      'same number+slug is an add/add collision under the counter scheme'
    );
  } finally {
    r.cleanup();
  }
});

test('timestamp-id filenames never collide, even for the same slug', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'decisions/.gitkeep', ''),
    a: (d) => write(d, 'decisions/260703-081200-topic.md', '# a\n'),
    b: (d) => write(d, 'decisions/260703-090000-topic.md', '# b\n'),
  });
  try {
    assert.equal(
      r.conflicted,
      false,
      'distinct timestamp ids yield distinct filenames — no add/add'
    );
  } finally {
    r.cleanup();
  }
});

// ── CHANGELOG ────────────────────────────────────────────────────────────────

const changelog = (addedLines: string[], anchor = false) =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${addedLines.map((l) => l + '\n').join('')}${anchor ? '<!-- FLOW:ADD-ABOVE Added -->\n' : ''}`;

test('NEGATIVE CONTROL: single-block CHANGELOG — concurrent same-section appends conflict (default driver)', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'CHANGELOG.md', changelog(['- base'])),
    a: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from a'])),
    b: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from b'])),
  });
  try {
    assert.equal(r.conflicted, true, 'this is the current changelog pain');
  } finally {
    r.cleanup();
  }
});

test('merge=union resolves concurrent same-section appends locally (both kept)', () => {
  const r = twoWayMerge({
    base: (d) => {
      write(d, '.gitattributes', 'CHANGELOG.md merge=union\n');
      write(d, 'CHANGELOG.md', changelog(['- base']));
    },
    a: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from a'])),
    b: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from b'])),
  });
  try {
    assert.equal(r.conflicted, false, 'union takes both sides');
    const c = r.read('CHANGELOG.md');
    assert.ok(c.includes('- from a') && c.includes('- from b'), 'both entries survive');
    // Caveat (not asserted): union does NOT run on GitHub server-side merges.
  } finally {
    r.cleanup();
  }
});

test('DISPROVEN: a sentinel anchor alone does NOT prevent same-section conflicts', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'CHANGELOG.md', changelog(['- base'], true)),
    a: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from a'], true)),
    b: (d) => write(d, 'CHANGELOG.md', changelog(['- base', '- from b'], true)),
  });
  try {
    // Both branches insert immediately above the same anchor line — same position,
    // so the default driver still conflicts. Evidence to drop the sentinel idea.
    assert.equal(r.conflicted, true, 'sentinel does not help same-section concurrent inserts');
  } finally {
    r.cleanup();
  }
});

test('one-file-per-entry changelog never conflicts', () => {
  const r = twoWayMerge({
    base: (d) => write(d, 'changelog.d/.gitkeep', ''),
    a: (d) => write(d, 'changelog.d/260703-081200.md', 'Added: from a\n'),
    b: (d) => write(d, 'changelog.d/260703-090000.md', 'Added: from b\n'),
  });
  try {
    assert.equal(r.conflicted, false, 'distinct per-entry files are the only hard guarantee');
  } finally {
    r.cleanup();
  }
});
