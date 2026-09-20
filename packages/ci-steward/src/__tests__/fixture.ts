/**
 * A small, self-consistent repo on disk that the census passes clean.
 *
 * Each test builds the spec, plants exactly one drift by mutating it, writes it
 * to a temp directory, and asserts the census names that drift. Starting from a
 * tree that is proven clean is what makes "the census fails on X" mean X, not
 * some unrelated gap in the fixture.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

type Json = Record<string, unknown>;

export interface FixtureSpec {
  config: Json;
  requiredChecks: { ruleset: number; contexts: string[] };
  gates: { gates: { id: string; source: string; purpose: string }[] };
  slos: Json;
  metrics: Json;
  ratchets: Json;
  stewardOwned: { description: string; paths: string[] };
  allowlist: { entries: Json[] };
  workflows: Record<string, Json>;
  lefthook: Json;
  claudeSettings: Json;
  docs: Record<string, string>;
  ledger: Record<string, string>;
  extraFiles: Record<string, string>;
}

/** The instant every fixture runs at; nothing reads the real clock. */
export const NOW = new Date('2026-09-20T12:00:00Z');

const BLOCK = [
  '<!-- ci-steward:required-checks:start -->',
  '- `lint`',
  '- `test`',
  '<!-- ci-steward:required-checks:end -->',
].join('\n');

export function baseSpec(): FixtureSpec {
  const wfSource = (f: string) => `.github/workflows/${f}`;
  return {
    config: {
      version: 1,
      default_branch: 'main',
      workflows_dir: '.github/workflows',
      lefthook: 'lefthook.yml',
      claude_settings: '.claude/settings.json',
      claude_hook_wrappers: ['.claude/hooks/run-node-hook.sh'],
      root_package_json: 'package.json',
      data_branch: 'ci-steward-data',
      data_ruleset_id: 2,
      github_repo: 'o/r',
      data_tag_prefix: 'ci-steward-data/',
      data_tag_ruleset_id: 3,
      ruleset: { id: 1, integration_id: 15368, rules: ['merge_queue', 'required_status_checks'] },
      hand_files: {
        required_checks: 'ci/required-checks.json',
        gates: 'ci/gates.yaml',
        slos: 'ci/slos.yaml',
        metrics: 'ci/metrics.yaml',
        ratchets: 'ci/ratchets.yaml',
        steward_owned_paths: 'ci/steward-owned-paths.json',
        census_allowlist: 'ci/census-allowlist.yaml',
      },
      ledger_dir: 'ci/ledger',
      coverage: { paths: ['.github/workflows/**', 'lefthook.yml', 'ci/**'] },
      fence_branch_prefix: 'ci-improve/',
      generated_blocks: { required_checks: ['docs/ci.md'] },
      commands: { ledger_new: 'pnpm ci:ledger-new', census_fix: 'pnpm ci:census --fix' },
      collect: {
        api_budget: 700,
        lookback_days: 7,
        backfill_from: null,
        artifact_builds_per_day: 2,
        review_workflow: 'review.yml',
        artifacts: [
          {
            workflow: 'browser-test.yml',
            pattern: 'browser-results-shard-*',
            format: 'playwright',
          },
          { workflow: 'test.yml', pattern: 'vitest-shard-report-*', format: 'vitest' },
        ],
      },
      quarantine: {
        file: 'quarantine.json',
        max_entries: 3,
        default_expiry_days: 7,
        max_expiry_days: 14,
        window_days: 14,
        min_occurrences: 2,
        cooling_min_clean_builds: 2,
        near_expiry_hours: 48,
      },
      // The two fixture workflows that carry the canary's schedule and
      // workflow_dispatch triggers; the census holds the pair together.
      // Deliberately not lint.yml: the deadlock cases rewrite its `on:` block
      // wholesale, and a canary finding there would be noise in every one.
      canary: { workflows: ['test.yml', 'nightly.yml'] },
      verdicts: { before_days: 7, min_n: 5 },
      triage: {
        failure_spike_ratio: 1.5,
        failure_spike_min_n: 20,
        failure_spike_absolute: 0.1,
        spike_min_days: 5,
        duration_growth: 0.25,
        minutes_growth: 0.2,
        repeat_ejection_min: 3,
        repeat_ejection_days: 7,
        headroom_ratio: 0.9,
        collector_health_days: 3,
        stale_verdict_days: 7,
        stale_proposed_days: 30,
        canary_red_min_runs: 1,
        canary_silent_hours: 18,
        open_days_warning: 14,
        sparkline_days: 14,
      },
      local: {
        timings_file: 'ci-steward/local-timings.jsonl',
        killed_after_seconds: 7500,
        tool_ceiling_seconds: 600,
        retention_days: 30,
        max_bytes: 5000000,
        stale_after_days: 3,
        retired_after_days: 14,
      },
    },
    requiredChecks: { ruleset: 1, contexts: ['lint', 'test'] },
    gates: {
      gates: [
        { id: 'wf.lint.lint', source: wfSource('lint.yml'), purpose: 'Lints every package.' },
        { id: 'wf.test.test-shard', source: wfSource('test.yml'), purpose: 'Runs one test shard.' },
        { id: 'wf.test.test', source: wfSource('test.yml'), purpose: 'Fan-in of the shards.' },
        {
          id: 'wf.nightly.report',
          source: wfSource('nightly.yml'),
          purpose: 'Nightly report run.',
        },
        { id: 'lefthook.pre-push.tests', source: 'lefthook.yml', purpose: 'Runs tests on push.' },
        {
          id: 'claude.PreToolUse.git-guard',
          source: '.claude/settings.json',
          purpose: 'Refuses git stash.',
        },
        {
          id: 'ruleset.merge_queue',
          source: 'github:ruleset/1',
          purpose: 'Everything goes through the queue.',
        },
        {
          id: 'ruleset.required_status_checks',
          source: 'github:ruleset/1',
          purpose: 'The required contexts must pass.',
        },
      ],
    },
    slos: {
      slos: [
        {
          id: 'queue-green',
          kind: 'quality',
          title: 'Queue builds are green',
          definition: {
            event_source: 'merge_group runs',
            population: 'completed queue builds',
            exclusions: ['cancelled builds'],
            aggregation: 'share all green',
            window: '7-day non-overlapping',
            min_n: 30,
            fixture: 'pending',
          },
          today: '75%',
          floor: [{ stat: 'share', op: '>=', value: 0.75, unit: 'ratio' }],
          objective: [{ stat: 'share', op: '>=', value: 0.97, unit: 'ratio' }],
          path: 'quarantine',
        },
      ],
    },
    metrics: {
      gate_templates: [
        { metric: 'duration_p90', unit: 'minutes', definition: 'p90 job duration' },
        { metric: 'failure_rate', unit: 'ratio', definition: 'failed / completed' },
      ],
      event_qualifiers: ['merge_group', 'pull_request'],
      hook_templates: [{ metric: 'duration_p90', unit: 'seconds', definition: 'p90 wall time' }],
      queue: [{ id: 'queue.queue_wait', unit: 'minutes', definition: 'entry to merged' }],
      tracked: [{ id: 'tracked.escaped', unit: 'count', definition: 'escaped regressions' }],
      slo_metrics: ['queue-green'],
    },
    ratchets: {
      ratchets: [
        {
          id: 'lint-runs-census',
          kind: 'content',
          scope: 'repo',
          description: 'lint.yml keeps its census step.',
          measured_from: 'fixed-string match',
          enforced_by: 'ratchet-assert',
          enforced_from_phase: 2,
          file: '.github/workflows/lint.yml',
          must_contain: ['census'],
        },
      ],
    },
    stewardOwned: {
      description: 'The fence.',
      paths: ['ci/config.yaml', 'packages/ci-steward/**'],
    },
    allowlist: { entries: [] },
    workflows: {
      'lint.yml': {
        on: { pull_request: null, merge_group: null },
        jobs: {
          lint: {
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 15,
            steps: [
              { uses: 'actions/checkout@v7' },
              { name: 'Census', if: '${{ !cancelled() }}', run: 'echo census' },
              { name: 'Lint', run: 'bash scripts/lint.sh' },
            ],
          },
        },
      },
      'test.yml': {
        on: {
          pull_request: null,
          merge_group: null,
          schedule: [{ cron: '37 0,6,12,18 * * *' }],
          workflow_dispatch: null,
        },
        jobs: {
          'test-shard': {
            name: 'test-shard (${{ matrix.shard }}/2)',
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 30,
            strategy: { matrix: { shard: [1, 2] } },
            steps: [{ run: 'pnpm test' }],
          },
          test: {
            needs: ['test-shard'],
            if: '${{ always() }}',
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 10,
            steps: [
              {
                name: 'Refuse a red shard',
                run: 'test "${{ needs.test-shard.result }}" = success',
              },
            ],
          },
        },
      },
      'nightly.yml': {
        on: { schedule: [{ cron: '0 5 * * *' }], workflow_dispatch: null },
        jobs: {
          report: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 10, steps: [{ run: 'true' }] },
        },
      },
    },
    lefthook: {
      'pre-push': { commands: { tests: { run: 'bash scripts/pre-push.sh' } } },
    },
    claudeSettings: {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/run-node-hook.sh .claude/hooks/git-guard.mjs || exit 2',
              },
            ],
          },
        ],
      },
    },
    docs: { 'docs/ci.md': `# CI\n\nRequired:\n\n${BLOCK}\n\nEnd.\n` },
    ledger: {},
    extraFiles: {
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/unit.sh' } }),
      'scripts/lint.sh': 'true\n',
      'scripts/pre-push.sh': 'true\n',
      'scripts/unit.sh': 'true\n',
      '.claude/hooks/run-node-hook.sh': 'true\n',
      '.claude/hooks/git-guard.mjs': '\n',
    },
  };
}

function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** Write a spec to a fresh temp directory and return its path. */
export function writeRepo(spec: FixtureSpec, root?: string): string {
  const dir = root ?? mkdtempSync(path.join(tmpdir(), 'ci-steward-fixture-'));
  put(dir, 'ci/config.yaml', stringify(spec.config));
  put(dir, 'ci/required-checks.json', JSON.stringify(spec.requiredChecks, null, 2));
  put(dir, 'ci/gates.yaml', stringify(spec.gates));
  put(dir, 'ci/slos.yaml', stringify(spec.slos));
  put(dir, 'ci/metrics.yaml', stringify(spec.metrics));
  put(dir, 'ci/ratchets.yaml', stringify(spec.ratchets));
  put(dir, 'ci/steward-owned-paths.json', JSON.stringify(spec.stewardOwned, null, 2));
  put(dir, 'ci/census-allowlist.yaml', stringify(spec.allowlist));
  for (const [f, wf] of Object.entries(spec.workflows)) {
    put(dir, `.github/workflows/${f}`, stringify(wf));
  }
  put(dir, 'lefthook.yml', stringify(spec.lefthook));
  put(dir, '.claude/settings.json', JSON.stringify(spec.claudeSettings, null, 2));
  for (const [rel, text] of Object.entries({ ...spec.docs, ...spec.extraFiles }))
    put(dir, rel, text);
  mkdirSync(path.join(dir, 'ci/ledger'), { recursive: true });
  for (const [name, text] of Object.entries(spec.ledger)) put(dir, `ci/ledger/${name}`, text);
  return dir;
}

/** Access a workflow job in a spec for mutation. */
export function job(spec: FixtureSpec, workflow: string, id: string): Json {
  return (spec.workflows[workflow]!.jobs as Record<string, Json>)[id]!;
}

/** A valid experiment ledger entry, with optional frontmatter overrides. */
export function ledgerEntry(
  id: string,
  overrides: Record<string, unknown> = {},
  body = 'Why we did it, and what would make us revert.'
): string {
  const fm = {
    id,
    title: 'Shard the lint job',
    kind: 'experiment',
    status: 'proposed',
    actor: 'agent',
    gates: ['wf.lint.lint'],
    prs: [],
    hypothesis: {
      metric: 'gate.wf.lint.lint.duration_p90',
      slo: 'queue-green',
      baseline: 6,
      baseline_source: 'a 30-run sample',
      target: 3,
      after_days: 14,
    },
    'ratchet-release': [],
    'field-changes': [],
    ...overrides,
  };
  return `---\n${stringify(fm)}---\n\n${body}\n`;
}
