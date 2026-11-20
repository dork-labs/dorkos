/**
 * Landing PRs: a ledger entry whose `prs:` is empty is anchored on the PR that
 * added its file, looked up once and cached on the data branch, and read by the
 * verdict engine as `active` without its file ever being rewritten.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readData } from '../data.ts';
import { replayGh, type Recording } from '../gh.ts';
import { checkLedger, readLedger } from '../ledger.ts';
import { loadHandFiles } from '../load.ts';
import {
  effectiveLedger,
  fetchMergeTimes,
  landingMergeTimes,
  LedgerPrSchema,
  ledgerPrPath,
  pendingLandingLookups,
  resolveLandingPrs,
  verdictInputs,
} from '../steward.ts';
import type { LedgerEntry } from '../verdicts.ts';
import { baseSpec, ledgerEntry, NOW, writeRepo } from './fixture.ts';

const REPO = 'o/r';
const ID = '260919-120000';
const FILE = `ci/ledger/${ID}-shard-lint.md`;
const COMMITS = `repos/${REPO}/commits?path=${FILE}&per_page=100`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ci-steward-landing-'));
  dirs.push(d);
  return d;
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: ID,
    title: 'Shard the lint job',
    kind: 'experiment',
    status: 'proposed',
    actor: 'agent',
    gates: ['wf.lint.lint'],
    prs: [],
    hypothesis: {
      metric: 'gate.wf.lint.lint.duration_p90',
      baseline: 6,
      baseline_source: 'a 30-run sample',
      target: 3,
      after_days: 14,
    },
    'ratchet-release': [],
    'floor-release': [],
    'field-changes': [],
    file: FILE,
    ...overrides,
  } as LedgerEntry;
}

/** The file's history, newest first as the API returns it: an edit, then the commit that added it. */
function landed(): Recording {
  return {
    rest: {
      [COMMITS]: [{ sha: 'edit2' }, { sha: 'edit1' }, { sha: 'added' }],
      [`repos/${REPO}/commits/added/pulls`]: [
        // Open, and merged into another base: neither landed the entry on main.
        { number: 40, merged_at: null, base: { ref: 'main' } },
        { number: 41, merged_at: '2026-09-10T08:00:00Z', base: { ref: 'release' } },
        { number: 42, merged_at: '2026-09-12T10:00:00Z', base: { ref: 'main' } },
      ],
    },
  };
}

const resolve = (gh: ReturnType<typeof replayGh>, dir: string, ledger: LedgerEntry[]) =>
  resolveLandingPrs(gh, REPO, dir, ledger, { now: NOW, base: 'main' });

describe('resolveLandingPrs', () => {
  it("anchors on the merged PR into main of the file's oldest commit", () => {
    const gh = replayGh(landed());
    const got = resolve(gh, dataDir(), [entry()]);
    expect(got.get(ID)).toMatchObject({ pr: 42, merged_at: '2026-09-12T10:00:00Z', sha: 'added' });
    expect(gh.calls).toBe(2);
  });

  it('writes the cache, then reuses it with no further request', () => {
    const dir = dataDir();
    expect(pendingLandingLookups(dir, [entry()])).toBe(1);
    resolve(replayGh(landed()), dir, [entry()]);
    expect(readData(dir, ledgerPrPath(ID), LedgerPrSchema)).toEqual({
      schema: 1,
      id: ID,
      file: FILE,
      pr: 42,
      merged_at: '2026-09-12T10:00:00Z',
      sha: 'added',
      resolved_at: NOW.toISOString(),
    });
    expect(pendingLandingLookups(dir, [entry()])).toBe(0);
    // A client with no recordings throws on any request, so a hit proves the cache answered.
    const empty = replayGh({ rest: {} });
    expect(resolve(empty, dir, [entry()]).get(ID)?.pr).toBe(42);
    expect(empty.calls).toBe(0);
  });

  it('skips an entry whose lookup fails, caches nothing, and does not throw', () => {
    const dir = dataDir();
    const other = entry({ id: '260920-120000', file: 'ci/ledger/260920-120000-other.md' });
    const rec = landed();
    rec.rest[`repos/${REPO}/commits?path=${other.file}&per_page=100`] = new Error('HTTP 502');
    const got = resolve(replayGh(rec), dir, [other, entry()]);
    expect(got.has(other.id)).toBe(false);
    expect(got.get(ID)?.pr).toBe(42);
    expect(existsSync(path.join(dir, ledgerPrPath(other.id)))).toBe(false);
    // An unrecorded path throws too: still no exception.
    expect(() => resolve(replayGh({ rest: {} }), dataDir(), [entry()])).not.toThrow();
  });

  it('skips an entry when no merged PR into main added it, and remembers that', () => {
    const dir = dataDir();
    const rec: Recording = {
      rest: {
        [COMMITS]: [{ sha: 'direct' }],
        [`repos/${REPO}/commits/direct/pulls`]: [
          { number: 9, merged_at: '2026-09-12T10:00:00Z', base: { ref: 'release' } },
        ],
      },
    };
    expect(resolve(replayGh(rec), dir, [entry()]).size).toBe(0);
    expect(readData(dir, ledgerPrPath(ID), LedgerPrSchema)?.pr).toBeNull();
    const empty = replayGh({ rest: {} });
    expect(resolve(empty, dir, [entry()]).size).toBe(0);
    expect(empty.calls).toBe(0);
  });

  it('skips a file not on the default branch yet without caching it', () => {
    const dir = dataDir();
    expect(resolve(replayGh({ rest: { [COMMITS]: [] } }), dir, [entry()]).size).toBe(0);
    expect(existsSync(path.join(dir, ledgerPrPath(ID)))).toBe(false);
  });

  it('never looks up an entry that names its own PRs', () => {
    const gh = replayGh({ rest: {} });
    expect(resolve(gh, dataDir(), [entry({ prs: [7] })]).size).toBe(0);
    expect(gh.calls).toBe(0);
  });

  it('stops at the per-run cap and at a spent budget, without throwing', () => {
    const a = entry({ id: '260920-120000', file: 'ci/ledger/260920-120000-a.md' });
    const capped = replayGh({ rest: {} });
    resolveLandingPrs(capped, REPO, dataDir(), [a, entry()], { now: NOW, limit: 1 });
    expect(capped.calls).toBe(1);
    const broke = replayGh(landed(), 1);
    expect(() => resolve(broke, dataDir(), [entry()])).not.toThrow();
  });
});

describe('effectiveLedger', () => {
  const landing = new Map([
    [ID, { pr: 42 }],
    ['260920-000001', { pr: 50 }],
    ['260920-000002', { pr: 51 }],
    ['260920-000003', { pr: 52 }],
  ]);

  it('sets active only on a proposed entry that resolved, and keeps everything else', () => {
    const [resolved, unresolved, explicit, withdrawn, reverted] = effectiveLedger(
      [
        entry(),
        entry({ id: '260920-999999' }),
        entry({ id: '260920-000001', prs: [7] }),
        entry({ id: '260920-000002', status: 'withdrawn' }),
        entry({ id: '260920-000003', status: 'reverted' }),
      ],
      landing
    );
    expect(resolved).toMatchObject({ status: 'active', prs: [42] });
    expect(unresolved).toMatchObject({ status: 'proposed', prs: [] });
    expect(explicit).toMatchObject({ status: 'proposed', prs: [7] });
    expect(withdrawn).toMatchObject({ status: 'withdrawn', prs: [51] });
    expect(reverted).toMatchObject({ status: 'reverted', prs: [52] });
  });

  it('feeds the cached merge times to fetchMergeTimes instead of asking again', () => {
    const dir = dataDir();
    const landingPrs = resolve(replayGh(landed()), dir, [entry()]);
    const ledger = effectiveLedger([entry(), entry({ id: '260920-000001', prs: [7] })], landingPrs);
    const gh = replayGh({
      rest: { [`repos/${REPO}/pulls/7`]: { merged_at: '2026-09-01T00:00:00Z' } },
    });
    const merged = fetchMergeTimes(gh, REPO, ledger, landingMergeTimes(landingPrs));
    expect([...merged]).toEqual([
      [7, '2026-09-01T00:00:00Z'],
      [42, '2026-09-12T10:00:00Z'],
    ]);
    expect(gh.calls).toBe(1);
  });
});

describe('verdictInputs', () => {
  it('budgets two requests per fresh lookup, and returns the effective ledger with its merge times', () => {
    const rec = landed();
    rec.rest[`repos/${REPO}/pulls/7`] = { merged_at: '2026-09-01T00:00:00Z' };
    const budgets: number[] = [];
    const { ledger, merged } = verdictInputs(
      (b) => (budgets.push(b), replayGh(rec, b)),
      REPO,
      dataDir(),
      [entry(), entry({ id: '260920-000001', prs: [7] })],
      { now: NOW, base: 'main' }
    );
    // One explicit PR, one fresh lookup (two requests), five spare.
    expect(budgets).toEqual([8]);
    expect(ledger.map((e) => [e.status, e.prs])).toEqual([
      ['active', [42]],
      ['proposed', [7]],
    ]);
    expect(merged.get(42)).toBe('2026-09-12T10:00:00Z');
    expect(merged.get(7)).toBe('2026-09-01T00:00:00Z');
  });
});

describe('the authored ledger is untouched', () => {
  it('readLedger names each file, and ledger-check reads the files, not the effective view', () => {
    const spec = baseSpec();
    spec.ledger = { [`${ID}-shard-lint.md`]: ledgerEntry(ID) };
    const root = writeRepo(spec);
    dirs.push(root);
    const files = loadHandFiles(root).files!;
    const before = readFileSync(path.join(root, FILE), 'utf8');
    const authored = readLedger(root, files);
    expect(authored.map((e) => e.file)).toEqual([FILE]);
    const effective = effectiveLedger(authored, resolve(replayGh(landed()), dataDir(), authored));
    expect(effective[0]).toMatchObject({ status: 'active', prs: [42] });
    expect(authored[0]).toMatchObject({ status: 'proposed', prs: [] });
    expect(readFileSync(path.join(root, FILE), 'utf8')).toBe(before);
    expect(checkLedger(root, files)).toEqual([]);
  });
});
