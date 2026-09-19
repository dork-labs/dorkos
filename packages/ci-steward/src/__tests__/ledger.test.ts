/**
 * ledger-check validity and coverage, proven to fail on each planted defect.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGates } from '../census.ts';
import { checkCoverage, type ChangedFile } from '../coverage.ts';
import { readRootScripts } from '../discover.ts';
import { checkLedger } from '../ledger.ts';
import { loadHandFiles } from '../load.ts';
import { loadWorkflows } from '../workflows.ts';
import { baseSpec, ledgerEntry, writeRepo, type FixtureSpec } from './fixture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(spec: FixtureSpec) {
  const root = writeRepo(spec);
  dirs.push(root);
  const { files, findings } = loadHandFiles(root);
  expect(findings).toEqual([]);
  return { root, files: files! };
}

function validity(ledger: Record<string, string>): string[] {
  const spec = baseSpec();
  spec.ledger = ledger;
  const { root, files } = repo(spec);
  return checkLedger(root, files).map((f) => f.code);
}

const ID = '260919-120000';
const FILE = `${ID}-shard-lint.md`;

describe('ledger-check validity', () => {
  it('passes a well-formed experiment entry', () => {
    expect(validity({ [FILE]: ledgerEntry(ID) })).toEqual([]);
  });

  it('passes a hygiene entry with no hypothesis', () => {
    expect(
      validity({ [FILE]: ledgerEntry(ID, { kind: 'hygiene', hypothesis: undefined }) })
    ).toEqual([]);
  });

  it('rejects a computed verdict status, saying verdicts live on the data branch', () => {
    const spec = baseSpec();
    spec.ledger = { [FILE]: ledgerEntry(ID, { status: 'verified' }) };
    const { root, files } = repo(spec);
    const [finding] = checkLedger(root, files);
    expect(finding!.code).toBe('ledger/computed-status');
    expect(finding!.message).toContain('ci-steward-data');
  });

  it('rejects an unknown status', () => {
    expect(validity({ [FILE]: ledgerEntry(ID, { status: 'done' }) })).toEqual(['ledger/schema']);
  });

  it('rejects a metric id that is not in the catalogue', () => {
    const bad = (metric: string) =>
      validity({
        [FILE]: ledgerEntry(ID, {
          hypothesis: { metric, baseline: 1, baseline_source: 's', target: 0, after_days: 7 },
        }),
      });
    expect(bad('gate.wf.lint.lint.duration_p99')).toEqual(['ledger/metric']);
    expect(bad('gate.wf.lint.nope.duration_p90')).toEqual(['ledger/metric']);
    expect(bad('hook.pre-commit.duration_p90')).toEqual(['ledger/metric']);
    expect(bad('queue.nope')).toEqual(['ledger/metric']);
    expect(bad('lint-speed')).toEqual(['ledger/metric']);
    // Only the catalogue's event qualifiers, and only once.
    expect(bad('gate.wf.lint.lint.duration_p90@push')).toEqual(['ledger/metric']);
    expect(bad('gate.wf.lint.lint.duration_p90@merge_group@pull_request')).toEqual([
      'ledger/metric',
    ]);
  });

  it('accepts every catalogue family: gate, hook, queue, tracked, SLO', () => {
    for (const metric of [
      'gate.wf.lint.lint.failure_rate',
      'gate.wf.lint.lint.failure_rate@merge_group',
      'gate.wf.lint.lint.duration_p90@pull_request',
      'gate.lefthook.pre-push.tests.duration_p90',
      'hook.pre-push.duration_p90',
      'queue.queue_wait',
      'tracked.escaped',
      'queue-green',
    ]) {
      expect(
        validity({
          [FILE]: ledgerEntry(ID, {
            hypothesis: { metric, baseline: 1, baseline_source: 's', target: 0, after_days: 7 },
          }),
        })
      ).toEqual([]);
    }
  });

  it('requires baseline_source, because no latest.json snapshot exists yet', () => {
    expect(
      validity({
        [FILE]: ledgerEntry(ID, {
          hypothesis: { metric: 'queue-green', baseline: 0.75, target: 0.9, after_days: 14 },
        }),
      })
    ).toEqual(['ledger/baseline-source']);
  });

  it('lets only a proposed entry defer its baseline', () => {
    const hyp = {
      metric: 'queue-green',
      baseline: null,
      baseline_source: 's',
      target: 0.9,
      after_days: 14,
    };
    expect(validity({ [FILE]: ledgerEntry(ID, { hypothesis: hyp }) })).toEqual([]);
    expect(validity({ [FILE]: ledgerEntry(ID, { hypothesis: hyp, status: 'active' }) })).toEqual([
      'ledger/baseline',
    ]);
  });

  it('requires a hypothesis unless the entry is hygiene', () => {
    expect(validity({ [FILE]: ledgerEntry(ID, { hypothesis: undefined }) })).toEqual([
      'ledger/hypothesis-missing',
    ]);
  });

  it('rejects an id that differs from the file name, and a file name without an id', () => {
    expect(validity({ [FILE]: ledgerEntry('260919-120001') })).toEqual(['ledger/id']);
    expect(validity({ 'shard-lint.md': ledgerEntry(ID) })).toEqual(['ledger/filename']);
    expect(validity({ '261399-120000-bad-date.md': ledgerEntry('261399-120000') })).toEqual([
      'ledger/id',
    ]);
  });

  it('skips gate existence for withdrawn and reverted entries, whose gates may be gone', () => {
    const gone = {
      gates: ['wf.lint.removed'],
      hypothesis: {
        metric: 'gate.wf.lint.removed.duration_p90',
        baseline: 6,
        baseline_source: 's',
        target: 3,
        after_days: 14,
      },
    };
    expect(validity({ [FILE]: ledgerEntry(ID, { ...gone, status: 'reverted' }) })).toEqual([]);
    expect(validity({ [FILE]: ledgerEntry(ID, { ...gone, status: 'withdrawn' }) })).toEqual([]);
    expect(validity({ [FILE]: ledgerEntry(ID, { ...gone, status: 'active' }) })).toEqual([
      'ledger/gate',
      'ledger/metric',
    ]);
  });

  it('rejects unknown gates, unknown ratchets and unknown SLOs', () => {
    expect(validity({ [FILE]: ledgerEntry(ID, { gates: ['wf.lint.nope'] }) })).toEqual([
      'ledger/gate',
    ]);
    expect(
      validity({
        [FILE]: ledgerEntry(ID, {
          'ratchet-release': [{ ratchet: 'nope', package: 'x', value: 1, reason: 'r' }],
        }),
      })
    ).toEqual(['ledger/ratchet']);
    expect(
      validity({
        [FILE]: ledgerEntry(ID, {
          hypothesis: {
            metric: 'queue-green',
            slo: 'nope',
            baseline: 1,
            baseline_source: 's',
            target: 0,
            after_days: 7,
          },
        }),
      })
    ).toEqual(['ledger/slo']);
  });

  it('forbids an unattended tick from authoring a field change', () => {
    expect(
      validity({
        [FILE]: ledgerEntry(ID, {
          actor: 'ci-improve-tick',
          'field-changes': [{ gate: 'wf.lint.lint', field: 'timeout-minutes', from: 15, to: 30 }],
        }),
      })
    ).toEqual(['ledger/tick-authority']);
  });

  it('rejects an empty body and an unknown frontmatter key', () => {
    expect(validity({ [FILE]: ledgerEntry(ID, {}, '') })).toEqual(['ledger/body']);
    expect(validity({ [FILE]: ledgerEntry(ID, { verdict: 'held' }) })).toEqual(['ledger/schema']);
  });
});

function coverage(
  changed: ChangedFile[],
  branch = 'feature/x',
  versions: { base?: Record<string, string>; head?: Record<string, string> } = {}
) {
  const { root, files } = repo(baseSpec());
  const findings: never[] = [];
  const workflows = loadWorkflows(root, files.config.workflows_dir, () => undefined);
  const gates = discoverGates(root, files, workflows, findings);
  const rootScripts = readRootScripts(root, 'package.json');
  return checkCoverage({
    root,
    files,
    workflows,
    gates,
    rootScripts,
    changed,
    branch,
    readBase: (rel) => versions.base?.[rel] ?? null,
    readHead: (rel) => versions.head?.[rel] ?? null,
  });
}

describe('ledger-check --coverage', () => {
  it('passes a PR that touches no pipeline source', () => {
    expect(coverage([{ status: 'M', path: 'apps/client/src/app.tsx' }])).toEqual([]);
  });

  it('fails a PR that changes a workflow with no ledger entry, printing the command', () => {
    const [finding, ...rest] = coverage([{ status: 'M', path: '.github/workflows/lint.yml' }]);
    expect(rest).toEqual([]);
    expect(finding!.code).toBe('coverage/missing-entry');
    expect(finding!.fix).toContain('pnpm ci:ledger-new --slug');
  });

  it('counts a script a gate invokes as pipeline source, directly or through a root script', () => {
    expect(coverage([{ status: 'M', path: 'scripts/lint.sh' }]).map((f) => f.code)).toEqual([
      'coverage/missing-entry',
    ]);
    // test.yml runs `pnpm test`, and the root `test` script runs scripts/unit.sh.
    expect(coverage([{ status: 'M', path: 'scripts/unit.sh' }]).map((f) => f.code)).toEqual([
      'coverage/missing-entry',
    ]);
    // A Claude hook's real script, behind its wrapper.
    expect(
      coverage([{ status: 'M', path: '.claude/hooks/git-guard.mjs' }]).map((f) => f.code)
    ).toEqual(['coverage/missing-entry']);
  });

  it('passes when the PR adds a ledger entry, but not when it only deletes one', () => {
    const wf = { status: 'M', path: '.github/workflows/lint.yml' };
    expect(coverage([wf, { status: 'A', path: `ci/ledger/${FILE}` }])).toEqual([]);
    expect(coverage([wf, { status: 'D', path: `ci/ledger/${FILE}` }]).map((f) => f.code)).toEqual([
      'coverage/missing-entry',
    ]);
  });

  it('counts an edited entry only when its prs: gains a number (a typo fix records nothing)', () => {
    const wf = { status: 'M', path: '.github/workflows/lint.yml' };
    const entry = { status: 'M', path: `ci/ledger/${FILE}` };
    const rel = `ci/ledger/${FILE}`;
    const before = ledgerEntry(ID, { prs: [1900] });
    const typoFix = ledgerEntry(ID, { prs: [1900], title: 'Shard the lint job, fixed' });
    const gained = ledgerEntry(ID, { prs: [1900, 1931], status: 'active' });
    expect(
      coverage([wf, entry], 'feature/x', { base: { [rel]: before }, head: { [rel]: typoFix } }).map(
        (f) => f.code
      )
    ).toEqual(['coverage/missing-entry']);
    expect(
      coverage([wf, entry], 'feature/x', { base: { [rel]: before }, head: { [rel]: gained } })
    ).toEqual([]);
  });

  it('fails a PR whose only change is a gate-invoked script, with no entry', () => {
    expect(coverage([{ status: 'M', path: 'scripts/pre-push.sh' }]).map((f) => f.code)).toEqual([
      'coverage/missing-entry',
    ]);
  });

  it('fences steward-owned paths on a ci-improve/* branch only', () => {
    const changed = [
      { status: 'M', path: 'ci/config.yaml' },
      { status: 'A', path: `ci/ledger/${FILE}` },
    ];
    expect(coverage(changed, 'feature/x')).toEqual([]);
    const fenced = coverage(changed, 'ci-improve/tune-shards');
    expect(fenced.map((f) => `${f.code} ${f.file}`)).toEqual([
      'fence/steward-owned ci/config.yaml',
    ]);
    expect(
      coverage(
        [{ status: 'M', path: 'packages/ci-steward/src/census.ts' }, ...changed.slice(1)],
        'ci-improve/x'
      ).map((f) => f.code)
    ).toEqual(['fence/steward-owned']);
  });
});
