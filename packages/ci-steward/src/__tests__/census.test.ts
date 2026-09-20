/**
 * The phase-0 exit gate: the census is proven to FAIL on each planted drift.
 *
 * Every case starts from `baseSpec()`, which the first test proves clean, and
 * plants exactly one defect. A census that passed these fixtures while
 * missing the defect would be a gate that certifies nothing.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCensus } from '../census.ts';
import { baseSpec, job, NOW, writeRepo, type FixtureSpec } from './fixture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function census(spec: FixtureSpec, opts: { now?: Date; fix?: boolean } = {}) {
  const root = writeRepo(spec);
  dirs.push(root);
  return { root, ...runCensus({ root, now: opts.now ?? NOW, fix: opts.fix }) };
}

function codes(spec: FixtureSpec, now?: Date): string[] {
  return census(spec, { now }).findings.map((f) => f.code);
}

describe('census on a clean tree', () => {
  it('passes the base fixture with no findings', () => {
    expect(census(baseSpec()).findings).toEqual([]);
  });
});

describe('census: gates.yaml reconciliation', () => {
  it('fails on a workflow job with no gates.yaml entry, naming the id and the line to add', () => {
    const spec = baseSpec();
    spec.gates.gates = spec.gates.gates.filter((g) => g.id !== 'wf.nightly.report');
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['gates/missing']);
    expect(findings[0]!.where).toBe('wf.nightly.report');
    expect(findings[0]!.fix).toContain('source: .github/workflows/nightly.yml');
  });

  it('fails on a gates.yaml entry whose gate no longer runs', () => {
    const spec = baseSpec();
    spec.gates.gates.push({
      id: 'wf.lint.format',
      source: '.github/workflows/lint.yml',
      purpose: 'A job that was deleted.',
    });
    expect(codes(spec)).toEqual(['gates/stale']);
  });

  it('fails on a lefthook command and a Claude hook missing from gates.yaml', () => {
    const spec = baseSpec();
    (spec.lefthook['pre-push'] as { commands: Record<string, unknown> }).commands.format = {
      run: 'prettier --check .',
    };
    spec.gates.gates = spec.gates.gates.filter((g) => g.id !== 'claude.PreToolUse.git-guard');
    const found = census(spec).findings.map((f) => `${f.code} ${f.where}`);
    expect(found).toEqual([
      'gates/missing lefthook.pre-push.format',
      'gates/missing claude.PreToolUse.git-guard',
    ]);
  });

  it('fails when a ruleset gate is not a rule the config lists', () => {
    const spec = baseSpec();
    spec.gates.gates.push({
      id: 'ruleset.deletion',
      source: 'github:ruleset/1',
      purpose: 'Nobody deletes main.',
    });
    expect(codes(spec)).toEqual(['gates/stale']);
  });
});

describe('census: timeouts', () => {
  it('fails on a job with no timeout-minutes', () => {
    const spec = baseSpec();
    delete job(spec, 'nightly.yml', 'report')['timeout-minutes'];
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['timeout/missing']);
    expect(findings[0]!.file).toBe('.github/workflows/nightly.yml');
    expect(findings[0]!.fix).toContain('max(10, ceil(3 × p95))');
  });

  it('accepts a live no-timeout exception, and fails once it expires', () => {
    const spec = baseSpec();
    delete job(spec, 'nightly.yml', 'report')['timeout-minutes'];
    spec.allowlist.entries.push({
      workflow: 'nightly.yml',
      job: 'report',
      kind: 'no-timeout',
      reason: 'No runs yet to measure a ceiling from.',
      expires: '2026-10-19',
    });
    expect(codes(spec)).toEqual([]);
    expect(codes(spec, new Date('2026-10-19T00:00:00Z'))).toEqual([
      'timeout/missing',
      'allowlist/expired',
    ]);
  });
});

describe('census: the main canary is a registry, not a convention', () => {
  it('fails when a canary workflow lost the trigger that makes it run', () => {
    // The config list and the workflow trigger are two halves of one thing and
    // nothing joins them at runtime. A canary that stopped running reads
    // exactly like a healthy main in every number on the report, so the census
    // is what holds the pair together.
    const spec = baseSpec();
    spec.workflows['nightly.yml']!.on = { schedule: [{ cron: '0 5 * * *' }] };
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['canary/missing-trigger']);
    expect(findings[0]!.message).toContain('no workflow_dispatch trigger');

    spec.workflows['nightly.yml']!.on = { workflow_dispatch: null };
    expect(codes(spec)).toEqual(['canary/missing-trigger']);
  });

  it('fails when canary.workflows names a workflow that is not there, and names ci/config.yaml', () => {
    const spec = baseSpec();
    const exempt = (spec.config.canary as { exempt: Record<string, string> }).exempt;
    spec.config.canary = { workflows: ['test.yml', 'gone.yml'], exempt };
    const { findings } = census(spec);
    // nightly.yml left the list, but it owns no required context, so only the
    // phantom file is a finding.
    expect(findings.map((f) => f.code)).toEqual(['canary/missing-workflow']);
    expect(findings[0]!.where).toBe('gone.yml');
    // The finding names the file the reader has to edit, not gates.yaml.
    expect(findings[0]!.file).toBe('ci/config.yaml');
  });

  it('fails when a required workflow is in neither list, so a deletion cannot go quiet', () => {
    // The one-directional failure the exempt list exists for: drop test.yml
    // from canary.workflows and, without this, the census stays green while
    // collection and the silence arm both stop watching the `test` context.
    const spec = baseSpec();
    const exempt = (spec.config.canary as { exempt: Record<string, string> }).exempt;
    spec.config.canary = { workflows: ['nightly.yml'], exempt };
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['canary/required-unwatched']);
    expect(findings[0]!.where).toBe('test.yml');
  });

  it('fails a canary workflow that declares a schedule with no cron', () => {
    // `schedule: []` reports green and fires nothing.
    const spec = baseSpec();
    spec.workflows['nightly.yml']!.on = { schedule: [], workflow_dispatch: null };
    expect(codes(spec)).toEqual(['canary/no-cron']);
  });

  it('fails a canary workflow whose every job skips on a scheduled run', () => {
    const spec = baseSpec();
    job(spec, 'nightly.yml', 'report').if = "${{ github.event_name == 'merge_group' }}";
    expect(codes(spec)).toEqual(['canary/no-job-runs']);
  });

  it('fails a workflow that is in both lists at once', () => {
    const spec = baseSpec();
    spec.config.canary = {
      workflows: ['test.yml', 'nightly.yml'],
      exempt: {
        'lint.yml': 'The fixture keeps one required workflow out of the canary on purpose.',
        'test.yml': 'Claiming both at once is the contradiction this catches.',
      },
    };
    expect(codes(spec)).toEqual(['canary/exempt-and-listed']);
  });
});

describe('census: the deadlock invariant', () => {
  it('fails on a paths: filter on a required workflow', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = { pull_request: { paths: ['src/**'] }, merge_group: null };
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['deadlock/paths-filter']);
    expect(findings[0]!.where).toBe('job lint, required context "lint"');
  });

  it('fails on paths-ignore too', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = {
      pull_request: { 'paths-ignore': ['docs/**'] },
      merge_group: null,
    };
    expect(codes(spec)).toEqual(['deadlock/paths-filter']);
  });

  it('fails when a required workflow lacks the merge_group trigger', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = { pull_request: null };
    expect(codes(spec)).toEqual(['deadlock/missing-trigger']);
  });

  it('fails on pull_request.types without synchronize', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = {
      pull_request: { types: ['opened', 'labeled'] },
      merge_group: null,
    };
    expect(codes(spec)).toEqual(['deadlock/types-no-synchronize']);
  });

  it('accepts pull_request.types that include synchronize', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = {
      pull_request: { types: ['opened', 'synchronize', 'labeled'] },
      merge_group: null,
    };
    expect(codes(spec)).toEqual([]);
  });

  it('fails on a branches filter that excludes the default branch', () => {
    const spec = baseSpec();
    spec.workflows['lint.yml']!.on = {
      pull_request: { branches: ['release/**'] },
      merge_group: null,
    };
    expect(codes(spec)).toEqual(['deadlock/branches-filter']);
  });

  it('fails on a required context that no job reports', () => {
    const spec = baseSpec();
    spec.requiredChecks.contexts.push('typecheck');
    spec.docs['docs/ci.md'] = spec.docs['docs/ci.md']!.replace(
      '- `test`\n',
      '- `test`\n- `typecheck`\n'
    );
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['deadlock/no-job']);
    expect(findings[0]!.file).toBe('ci/required-checks.json');
  });

  it('does not let a matrix job satisfy a context, because its check names are suffixed', () => {
    const spec = baseSpec();
    spec.requiredChecks.contexts = ['lint', 'test-shard'];
    spec.docs['docs/ci.md'] = spec.docs['docs/ci.md']!.replace('- `test`', '- `test-shard`');
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['deadlock/no-job']);
    expect(findings[0]!.message).toContain('matrix job');
  });

  it('matches a job by its name: when set, not by its id', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint').name = 'lint-all';
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['deadlock/no-job']);
  });

  it('fails on a job-level if: that is false on merge_group (a skipped required check passes)', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint').if = "${{ github.event_name == 'pull_request' }}";
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['deadlock/job-if-false']);
    expect(findings[0]!.message).toContain('merge_group');
    expect(findings[0]!.message).toContain('passes');
  });

  it('fails on a label-only job condition: undecidable on pull_request, false on merge_group', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint').if =
      "${{ contains(github.event.pull_request.labels.*.name, 'skip-changelog') }}";
    expect(codes(spec)).toEqual(['deadlock/job-if-undecidable', 'deadlock/job-if-false']);
  });

  it('accepts that label-only condition with a job-if exception', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint').if =
      "${{ contains(github.event.pull_request.labels.*.name, 'skip-changelog') }}";
    spec.allowlist.entries.push({
      workflow: 'lint.yml',
      job: 'lint',
      kind: 'job-if',
      reason: 'Label reconciliation only exists on the PR.',
    });
    expect(codes(spec)).toEqual([]);
  });

  it('routes a condition it cannot decide to the allowlist', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint').if = "${{ vars.LINT_ENABLED == 'true' }}";
    expect(codes(spec)).toEqual(['deadlock/job-if-undecidable', 'deadlock/job-if-undecidable']);
  });

  it('fails on a required fan-in whose needs: failure would skip it into a pass', () => {
    const spec = baseSpec();
    delete job(spec, 'test.yml', 'test').if;
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['required/needs-without-always']);
  });
});

describe('census: required jobs cannot hide a failure', () => {
  it('follows needs: a continue-on-error on a shard step the fan-in needs fails', () => {
    const spec = baseSpec();
    const steps = job(spec, 'test.yml', 'test-shard').steps as Record<string, unknown>[];
    steps[0]!['continue-on-error'] = true;
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['required/continue-on-error']);
    expect(findings[0]!.where).toContain('job test-shard, needed by required context "test"');
  });

  it('follows needs transitively, and applies the step-if rule there too', () => {
    const spec = baseSpec();
    (spec.workflows['test.yml']!.jobs as Record<string, unknown>).build = {
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
      steps: [{ name: 'Build', if: "${{ github.event_name == 'merge_group' }}", run: 'make' }],
    };
    job(spec, 'test.yml', 'test-shard').needs = ['build'];
    spec.gates.gates.push({
      id: 'wf.test.build',
      source: '.github/workflows/test.yml',
      purpose: 'Builds what the shards test.',
    });
    const { findings } = census(spec);
    expect(findings.map((f) => `${f.code} ${f.where}`)).toEqual([
      'required/step-if job build, needed by required context "test" (job test), step "Build"',
    ]);
  });

  it('fails an always() fan-in that never reads its needs results', () => {
    const spec = baseSpec();
    job(spec, 'test.yml', 'test').steps = [{ name: 'Done', run: 'echo ok' }];
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['required/fan-in-unasserted']);
    expect(findings[0]!.message).toContain('needs.test-shard.result');
  });

  it("accepts a fan-in that checks contains(needs.*.result, 'failure')", () => {
    const spec = baseSpec();
    job(spec, 'test.yml', 'test').steps = [
      { name: 'Refuse', if: "${{ contains(needs.*.result, 'failure') }}", run: 'exit 1' },
    ];
    spec.allowlist.entries.push({
      workflow: 'test.yml',
      job: 'test',
      step: 'Refuse',
      kind: 'step-if',
      reason: 'Fails the fan-in when any needed job failed.',
    });
    expect(codes(spec)).toEqual([]);
  });

  it('fails on continue-on-error in a required job', () => {
    const spec = baseSpec();
    job(spec, 'lint.yml', 'lint')['continue-on-error'] = true;
    expect(codes(spec)).toEqual(['required/continue-on-error']);
  });

  it('fails on continue-on-error on a step of a required job', () => {
    const spec = baseSpec();
    const steps = job(spec, 'lint.yml', 'lint').steps as Record<string, unknown>[];
    steps[2]!['continue-on-error'] = true;
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['required/continue-on-error']);
    expect(findings[0]!.where).toContain('step "Lint"');
  });

  it('ignores continue-on-error outside required jobs', () => {
    const spec = baseSpec();
    job(spec, 'nightly.yml', 'report')['continue-on-error'] = true;
    expect(codes(spec)).toEqual([]);
  });

  it('fails on an event-branching step if: in a required job', () => {
    const spec = baseSpec();
    const steps = job(spec, 'lint.yml', 'lint').steps as Record<string, unknown>[];
    steps[2]!.if = "${{ github.event_name == 'merge_group' }}";
    expect(codes(spec)).toEqual(['required/step-if']);
  });

  it('accepts a step if: that is true on both events on a green run', () => {
    // `!cancelled()` on the base fixture's Census step already proves this;
    // `success() && always()` is a second shape of the same fact.
    const spec = baseSpec();
    const steps = job(spec, 'lint.yml', 'lint').steps as Record<string, unknown>[];
    steps[2]!.if = '${{ success() && always() }}';
    expect(codes(spec)).toEqual([]);
  });

  it('accepts an allowlisted step if:, and a continue-on-error until its expiry', () => {
    const spec = baseSpec();
    const steps = job(spec, 'lint.yml', 'lint').steps as Record<string, unknown>[];
    steps[2]!.if = "${{ github.event_name == 'pull_request' }}";
    steps[2]!['continue-on-error'] = true;
    spec.allowlist.entries.push(
      {
        workflow: 'lint.yml',
        job: 'lint',
        step: 'Lint',
        kind: 'step-if',
        reason: 'Needs the PR diff, which merge_group lacks.',
      },
      {
        workflow: 'lint.yml',
        job: 'lint',
        step: 'Lint',
        kind: 'continue-on-error',
        reason: 'Temporary while a flaky upload is fixed.',
        expires: '2026-09-27',
      }
    );
    expect(codes(spec)).toEqual([]);
    expect(codes(spec, new Date('2026-09-27T00:00:00Z'))).toEqual([
      'required/continue-on-error',
      'allowlist/expired',
    ]);
  });
});

describe('census: the allowlist itself', () => {
  it('fails on an entry that excuses nothing', () => {
    const spec = baseSpec();
    spec.allowlist.entries.push({
      workflow: 'lint.yml',
      job: 'lint',
      step: 'Gone',
      kind: 'step-if',
      reason: 'A step that was since deleted.',
    });
    expect(codes(spec)).toEqual(['allowlist/stale']);
  });

  it('rejects a no-timeout entry without an expiry', () => {
    const spec = baseSpec();
    delete job(spec, 'nightly.yml', 'report')['timeout-minutes'];
    spec.allowlist.entries.push({
      workflow: 'nightly.yml',
      job: 'report',
      kind: 'no-timeout',
      reason: 'Forgot to say until when.',
    });
    const { findings } = census(spec);
    // The allowlist does not load, so the job it would have excused fails too.
    expect(findings.map((f) => f.code)).toEqual(['schema/invalid', 'timeout/missing']);
    expect(findings[0]!.message).toContain('expires');
  });
});

describe('census: generated doc blocks', () => {
  it('fails when a block drifts from required-checks.json', () => {
    const spec = baseSpec();
    spec.requiredChecks.contexts = ['test', 'lint'];
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toEqual(['docs/drift']);
    expect(findings[0]!.fix).toContain('pnpm ci:census --fix');
  });

  it('--fix rewrites only the block, and the tree is then clean', () => {
    const spec = baseSpec();
    spec.requiredChecks.contexts = ['test', 'lint'];
    const { root, findings, fixed } = census(spec, { fix: true });
    expect(findings).toEqual([]);
    expect(fixed).toEqual(['docs/ci.md']);
    expect(readFileSync(path.join(root, 'docs/ci.md'), 'utf8')).toBe(
      '# CI\n\nRequired:\n\n<!-- ci-steward:required-checks:start -->\n- `test`\n- `lint`\n<!-- ci-steward:required-checks:end -->\n\nEnd.\n'
    );
    expect(runCensus({ root, now: NOW }).findings).toEqual([]);
  });

  it('compares only the marker span, and --fix keeps a prettier-ignore wrapper around it', () => {
    // The real docs wrap the block so prettier cannot add blank lines inside it.
    const wrap = (inner: string) =>
      `# CI\n\n<!-- prettier-ignore-start -->\n${inner}\n<!-- prettier-ignore-end -->\n\nEnd.\n`;
    const block = (ctx: string[]) =>
      [
        '<!-- ci-steward:required-checks:start -->',
        ...ctx.map((c) => `- \`${c}\``),
        '<!-- ci-steward:required-checks:end -->',
      ].join('\n');
    const clean = baseSpec();
    clean.docs['docs/ci.md'] = wrap(block(['lint', 'test']));
    expect(census(clean).findings).toEqual([]);

    const drifted = baseSpec();
    drifted.docs['docs/ci.md'] = wrap(block(['lint']));
    expect(census(drifted).findings.map((f) => f.code)).toEqual(['docs/drift']);
    const { root, findings, fixed } = census(drifted, { fix: true });
    expect([findings, fixed]).toEqual([[], ['docs/ci.md']]);
    expect(readFileSync(path.join(root, 'docs/ci.md'), 'utf8')).toBe(wrap(block(['lint', 'test'])));
  });

  it('fails on a listed doc with no block, and on a listed doc that does not exist', () => {
    const spec = baseSpec();
    spec.docs['docs/ci.md'] = '# CI\n';
    spec.config.generated_blocks = { required_checks: ['docs/ci.md', 'docs/missing.md'] };
    expect(codes(spec)).toEqual(['docs/missing-block', 'docs/missing-file']);
  });
});

describe('census: hand-file schemas and cross-file consistency', () => {
  it('fails on a hand file that does not match its schema, naming the field', () => {
    const spec = baseSpec();
    (spec.slos.slos as Record<string, unknown>[])[0]!.kind = 'vibes';
    const { findings } = census(spec);
    expect(findings.map((f) => f.code)).toContain('schema/invalid');
    expect(findings.find((f) => f.code === 'schema/invalid')!.message).toContain('slos.0.kind');
  });

  it('fails when slo_metrics and slos.yaml disagree', () => {
    const spec = baseSpec();
    spec.metrics.slo_metrics = ['queue-green', 'pr-feedback'];
    expect(codes(spec)).toEqual(['xfile/slo-metrics']);
  });

  it('fails when required-checks.json names a different ruleset from the config', () => {
    const spec = baseSpec();
    spec.requiredChecks.ruleset = 99;
    expect(codes(spec)).toEqual(['xfile/ruleset-id']);
  });

  it('stops early, with one finding, when ci/config.yaml itself is invalid', () => {
    const spec = baseSpec();
    spec.config.version = 2;
    expect(codes(spec)).toEqual(['schema/invalid']);
  });
});
