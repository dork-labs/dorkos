/**
 * Pin suite for the two ADR corpus checkers:
 *
 *   - `.claude/scripts/adr-drift-check.mjs`   (hook-fast integrity checks)
 *   - `.claude/scripts/adr-staleness-scan.mjs` (on-demand staleness signals)
 *
 * WHY THIS EXISTS. Both scripts gate the trustworthiness of `decisions/`
 * metadata: the drift check runs on every SessionStart and must stay silent
 * on a clean corpus (a false positive teaches everyone to ignore it), while
 * the staleness scanner builds the /adr:audit worklist (a matcher drifting
 * loose stops catching stale citations; drifting strict floods the audit
 * with noise). Both directions are pinned, mirroring the hermetic-fixture
 * pattern of `check-vocab-gate.test.ts` — synthetic corpora in temp dirs, so
 * this suite can never red-light a PR because the real corpus changed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDrift,
  formatReport,
  normalizeKey,
  readFrontmatter,
  type ManifestDecision,
} from '../../.claude/scripts/adr-drift-check.mjs';
import {
  CITATION_RE,
  buildWorklist,
  findDeadPaths,
  findStaleCitations,
  scan,
} from '../../.claude/scripts/adr-staleness-scan.mjs';

const tempDirs: string[] = [];

/** A fresh temp directory, tracked for cleanup after the test. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adr-checks-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ManifestEntry = ManifestDecision;

/** Write a decisions/ dir with a manifest and matching ADR files. */
function makeCorpus(entries: ManifestEntry[], files?: Record<string, string>): string {
  const dir = makeTempDir();
  const decisionsDir = join(dir, 'decisions');
  mkdirSync(decisionsDir);
  writeFileSync(
    join(decisionsDir, 'manifest.json'),
    JSON.stringify({ version: 1, decisions: entries })
  );
  for (const entry of entries) {
    const key = entry.id ?? String(entry.number).padStart(4, '0');
    const name = `${key}-${entry.slug}.md`;
    const body =
      files?.[name] ??
      `---\nstatus: ${entry.status}\nsuperseded-by: ${entry.supersededBy ?? 'null'}\n---\n\n# ${key}\n`;
    writeFileSync(join(decisionsDir, name), body);
  }
  return decisionsDir;
}

const accepted = (number: number, slug: string): ManifestEntry => ({
  number,
  slug,
  status: 'accepted',
  created: '2026-03-01',
});

// ---------------------------------------------------------------------------
// drift check — clean corpus stays silent
// ---------------------------------------------------------------------------

describe('findDrift — clean corpus', () => {
  it('reports nothing for a consistent manifest, including a valid supersession pair', () => {
    const dir = makeCorpus([
      accepted(1, 'first'),
      { number: 2, slug: 'old', status: 'superseded', created: '2026-03-01', supersededBy: 3 },
      { number: 3, slug: 'new', status: 'accepted', created: '2026-04-01', supersedes: 2 },
      {
        id: '260701-010101',
        slug: 'amender',
        status: 'accepted',
        created: '2026-07-01',
        amends: 1,
      },
    ]);
    const findings = findDrift(dir);
    expect(formatReport(findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// drift check — every finding class fires
// ---------------------------------------------------------------------------

describe('findDrift — integrity violations', () => {
  it('flags superseded status without a supersededBy link', () => {
    const dir = makeCorpus([
      { number: 5, slug: 'lost', status: 'superseded', created: '2026-03-01' },
    ]);
    expect(findDrift(dir).linkIssues).toEqual([{ key: '0005', kind: 'superseded-without-link' }]);
  });

  it('flags supersedes aimed at a live target and amends aimed at a terminal one', () => {
    const dir = makeCorpus([
      accepted(1, 'live-parent'),
      {
        number: 2,
        slug: 'dead-parent',
        status: 'superseded',
        created: '2026-03-01',
        supersededBy: 3,
      },
      { number: 3, slug: 'full', status: 'accepted', created: '2026-04-01', supersedes: 1 },
      {
        id: '260701-010101',
        slug: 'bad-amender',
        status: 'accepted',
        created: '2026-07-01',
        amends: 2,
      },
    ]);
    const issues = findDrift(dir).linkIssues;
    expect(issues).toContainEqual({
      key: '0003',
      kind: 'supersedes-live-target',
      target: '0001',
      targetStatus: 'accepted',
    });
    expect(issues).toContainEqual({
      key: '260701-010101',
      kind: 'amends-terminal-target',
      target: '0002',
      targetStatus: 'superseded',
    });
  });

  it('accepts amends as an array and flags only the dangling element', () => {
    const dir = makeCorpus([
      accepted(1, 'parent-a'),
      {
        id: '260701-010101',
        slug: 'multi',
        status: 'accepted',
        created: '2026-07-01',
        amends: [1, 88],
      },
    ]);
    expect(findDrift(dir).linkIssues).toEqual([
      { key: '260701-010101', kind: 'dangling', field: 'amends', target: '0088' },
    ]);
  });

  it('flags supersededBy and amends links pointing at no known ADR', () => {
    const dir = makeCorpus([
      { number: 5, slug: 'a', status: 'superseded', created: '2026-03-01', supersededBy: 99 },
      {
        id: '260701-010101',
        slug: 'b',
        status: 'accepted',
        created: '2026-07-01',
        amends: '260601-000000',
      },
    ]);
    const dangling = findDrift(dir).linkIssues.filter(
      (issue: { kind: string }) => issue.kind === 'dangling'
    );
    expect(dangling).toEqual([
      { key: '0005', kind: 'dangling', field: 'supersededBy', target: '0099' },
      { key: '260701-010101', kind: 'dangling', field: 'amends', target: '260601-000000' },
    ]);
  });

  it('detects supersession cycles', () => {
    const dir = makeCorpus([
      { number: 1, slug: 'a', status: 'superseded', created: '2026-03-01', supersededBy: 2 },
      { number: 2, slug: 'b', status: 'superseded', created: '2026-03-02', supersededBy: 1 },
    ]);
    expect(findDrift(dir).cycles.length).toBeGreaterThan(0);
  });

  it('flags frontmatter status disagreeing with the manifest', () => {
    const dir = makeCorpus([accepted(7, 'drifted')], {
      '0007-drifted.md': '---\nstatus: deprecated\nsuperseded-by: null\n---\n',
    });
    expect(findDrift(dir).frontmatterDrift).toEqual([
      { key: '0007', field: 'status', file: 'deprecated', manifest: 'accepted' },
    ]);
  });

  it('flags a frontmatter supersedes/amends relation absent from the manifest', () => {
    const dir = makeCorpus(
      [
        accepted(1, 'parent'),
        { id: '260801-035912', slug: 'widener', status: 'accepted', created: '2026-08-01' },
      ],
      {
        '260801-035912-widener.md':
          '---\nstatus: accepted\nsupersedes: 0001\nsuperseded-by: null\n---\n',
      }
    );
    expect(findDrift(dir).frontmatterDrift).toContainEqual({
      key: '260801-035912',
      field: 'supersedes',
      file: '0001',
      manifest: 'absent',
    });
  });

  it('accepts frontmatter relations the manifest mirrors, including inline lists and annotations', () => {
    const dir = makeCorpus(
      [
        accepted(1, 'parent-a'),
        accepted(2, 'parent-b'),
        {
          id: '260701-010101',
          slug: 'multi',
          status: 'accepted',
          created: '2026-07-01',
          amends: [1, 2],
        },
      ],
      {
        '260701-010101-multi.md':
          '---\nstatus: accepted\namends: [0001, 0002 (one clause only)]\nsuperseded-by: null\n---\n',
      }
    );
    expect(findDrift(dir).frontmatterDrift).toEqual([]);
  });

  it('parses CRLF frontmatter identically to LF', () => {
    const dir = makeCorpus([accepted(7, 'windows')], {
      '0007-windows.md': '---\r\nstatus: deprecated\r\nsuperseded-by: null\r\n---\r\n',
    });
    expect(findDrift(dir).frontmatterDrift).toContainEqual({
      key: '0007',
      field: 'status',
      file: 'deprecated',
      manifest: 'accepted',
    });
  });

  it('names the other node in a two-node cycle', () => {
    const dir = makeCorpus([
      { number: 1, slug: 'a', status: 'superseded', created: '2026-03-01', supersededBy: 2 },
      { number: 2, slug: 'b', status: 'superseded', created: '2026-03-02', supersededBy: 1 },
    ]);
    expect(findDrift(dir).cycles).toContainEqual({ key: '0001', via: '0002' });
  });

  it('flags a frontmatter superseded-by the manifest never recorded', () => {
    const dir = makeCorpus(
      [
        {
          number: 27,
          slug: 'bridge',
          status: 'superseded',
          created: '2026-02-25',
          supersededBy: null,
        },
      ],
      { '0027-bridge.md': '---\nstatus: superseded\nsuperseded-by: 29\n---\n' }
    );
    const drift = findDrift(dir).frontmatterDrift;
    expect(drift).toContainEqual({
      key: '0027',
      field: 'superseded-by',
      file: '0029',
      manifest: 'null',
    });
  });

  it('does NOT flag numeric-vs-string link forms that normalize equal', () => {
    const dir = makeCorpus(
      [
        { number: 2, slug: 'old', status: 'superseded', created: '2026-03-01', supersededBy: 3 },
        accepted(3, 'new'),
      ],
      { '0002-old.md': '---\nstatus: superseded\nsuperseded-by: 3\n---\n' }
    );
    expect(findDrift(dir).frontmatterDrift).toEqual([]);
  });

  it('still reports orphans, slug mismatches, and missing files', () => {
    const dir = makeCorpus([accepted(1, 'renamed'), accepted(2, 'gone')]);
    writeFileSync(join(dir, '0009-orphan.md'), '---\nstatus: accepted\n---\n');
    rmSync(join(dir, '0002-gone.md'));
    writeFileSync(
      join(dir, '0001-other-slug.md'),
      '---\nstatus: accepted\nsuperseded-by: null\n---\n'
    );
    rmSync(join(dir, '0001-renamed.md'));
    const findings = findDrift(dir);
    expect(findings.orphans).toEqual([{ file: '0009-orphan.md', key: '0009' }]);
    expect(findings.slugMismatches).toEqual([
      { file: '0001-other-slug.md', key: '0001', manifestSlug: 'renamed' },
    ]);
    expect(findings.missingFiles.map((m: ManifestEntry) => m.slug)).toEqual(['gone']);
  });
});

describe('normalizeKey / readFrontmatter', () => {
  it('pads legacy numbers, passes timestamp ids through, treats null forms as null', () => {
    expect(normalizeKey(29)).toBe('0029');
    expect(normalizeKey('29')).toBe('0029');
    expect(normalizeKey('260726-193526')).toBe('260726-193526');
    expect(normalizeKey(null)).toBeNull();
    expect(normalizeKey('null')).toBeNull();
  });

  it('parses scalar frontmatter fields only from the leading block', () => {
    const fm = readFrontmatter(
      '---\nstatus: accepted\namends: 260701-010101\n---\n\nstatus: fake\n'
    );
    expect(fm).toEqual({ status: 'accepted', amends: '260701-010101' });
  });
});

// ---------------------------------------------------------------------------
// staleness scan — the citation matcher's discrimination is the whole game
// ---------------------------------------------------------------------------

describe('CITATION_RE', () => {
  const matches = (text: string) => [...text.matchAll(CITATION_RE)].map((m) => m[1]);

  it('matches the three citation forms', () => {
    expect(matches('per ADR-0027 and ADR 260711-154514, see decisions/0304-rollback.md')).toEqual([
      '0027',
      '260711-154514',
      '0304',
    ]);
  });

  it('rejects wildcard family citations and partial ids inside timestamps', () => {
    expect(matches('by design (ADR 260711-*): the file')).toEqual([]);
    expect(matches('ADR 260711-154514 §2')).toEqual(['260711-154514']);
  });
});

describe('findStaleCitations', () => {
  it('flags superseded/missing/archived citations and passes accepted ones', () => {
    const dir = makeTempDir();
    const file = join(dir, 'code.ts');
    writeFileSync(file, '// per ADR-0002\n// per ADR-0003\n// per ADR-0050\n// per ADR-0060\n');
    const statusByKey = new Map([
      ['0002', 'superseded'],
      ['0003', 'accepted'],
    ]);
    const stale = findStaleCitations([file], statusByKey, new Set(['0050']));
    expect(stale).toEqual([
      { file, line: 1, key: '0002', reason: 'superseded' },
      { file, line: 3, key: '0050', reason: 'archived' },
      { file, line: 4, key: '0060', reason: 'missing' },
    ]);
  });
});

describe('findDeadPaths', () => {
  it('flags missing cited paths, resolves live ones and src/ fallbacks, skips path-free ADRs', () => {
    const repo = makeTempDir();
    mkdirSync(join(repo, 'apps', 'client', 'src'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'client', 'src', 'live.ts'), '');
    const body = 'See `apps/client/src/live.ts`, `src/live.ts`, and `packages/gone/dead.ts`.';
    expect(findDeadPaths(body, repo)).toEqual({ dead: ['packages/gone/dead.ts'], total: 3 });
    expect(findDeadPaths('no cited paths here', repo)).toBeNull();
    expect(findDeadPaths('all alive: `apps/client/src/live.ts`', repo)).toBeNull();
  });
});

describe('buildWorklist', () => {
  const NOW = Date.parse('2026-08-06T00:00:00Z');

  it('selects unverified accepted ADRs, load-bearing first, then oldest', () => {
    const entries: ManifestEntry[] = [
      { number: 1, slug: 'old-uncited', status: 'accepted', created: '2026-02-01' },
      { number: 2, slug: 'cited', status: 'accepted', created: '2026-05-01' },
      {
        number: 3,
        slug: 'fresh',
        status: 'accepted',
        created: '2026-03-01',
        lastVerified: '2026-08-01',
      },
      { number: 4, slug: 'superseded', status: 'superseded', created: '2026-02-01' },
      {
        number: 5,
        slug: 'stale-verify',
        status: 'accepted',
        created: '2026-04-01',
        lastVerified: '2026-01-01',
      },
    ];
    const worklist = buildWorklist(entries, new Map([['0002', 9]]), new Map(), 120, NOW);
    expect(worklist.map((w: { key: string }) => w.key)).toEqual(['0002', '0001', '0005']);
  });
});

describe('scan — end to end on a synthetic repo', () => {
  it('assembles stale citations and the worklist from a repo fixture', () => {
    const repo = makeTempDir();
    makeCorpusAt(repo);
    const result = scan(repo, { now: Date.parse('2026-08-06T00:00:00Z') });
    expect(result.staleCitations).toEqual([
      { file: join('apps', 'code.ts'), line: 1, key: '0002', reason: 'superseded' },
    ]);
    expect(result.worklist.map((w: { key: string }) => w.key)).toEqual(['0003']);
  });

  /** decisions/ + one source file: 0002 superseded (cited), 0003 accepted. */
  function makeCorpusAt(repo: string): void {
    const decisionsDir = join(repo, 'decisions');
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(
      join(decisionsDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        decisions: [
          { number: 2, slug: 'old', status: 'superseded', created: '2026-03-01', supersededBy: 3 },
          { number: 3, slug: 'new', status: 'accepted', created: '2026-04-01' },
        ],
      })
    );
    writeFileSync(
      join(decisionsDir, '0003-new.md'),
      '---\nstatus: accepted\n---\nSee `apps/code.ts`.\n'
    );
    mkdirSync(join(repo, 'apps'));
    writeFileSync(join(repo, 'apps', 'code.ts'), '// per ADR-0002\n');
  }
});
