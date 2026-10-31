/** Plant source-pin, trigger and live-rule drift; every defect must refuse. */
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { runCensus } from '../census.ts';
import { requiredWorkflowPaths } from '../gatemap.ts';
import { replayGh } from '../gh.ts';
import { loadHandFiles } from '../load.ts';
import { checkLiveWorkflows, checkWorkflowIntent, UNREADABLE_CODE } from '../required-workflows.ts';
import { RequiredChecksSchema } from '../schemas.ts';
import { loadWorkflows } from '../workflows.ts';
import { baseSpec, writeRepo, NOW } from './fixture.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup() {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  const files = loadHandFiles(root).files!;
  const source = {
    ruleset_name: 'Trusted workflow',
    repository: 'o/r',
    repository_id: 42,
    path: '.github/workflows/lint.yml',
    ref: 'refs/heads/main',
    bypass_actors: [],
    enforcement: 'active' as const,
  };
  files.requiredChecks!.workflows = [source];
  const workflows = loadWorkflows(root, '.github/workflows', () => {});
  const rule = {
    id: 7,
    name: source.ruleset_name,
    source_type: 'Organization',
    source: 'o',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    current_user_can_bypass: 'never',
    conditions: {
      repository_name: { include: ['r'], exclude: [], protected: false },
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    },
    rules: [
      {
        type: 'workflows',
        parameters: {
          do_not_enforce_on_create: false,
          workflows: [{ repository_id: 42, path: source.path, ref: source.ref }],
        },
      },
    ],
  };
  const rest: Record<string, unknown> = {
    'orgs/o/rulesets?per_page=100&page=1': [{ id: 7, name: source.ruleset_name }],
    'orgs/o/rulesets/7': rule,
    'repos/o/r': { id: 42, full_name: 'o/r' },
  };
  return { root, files, source, workflows, rule, rest };
}
it('accepts exact intent and live org rule, including an explicitly empty bypass list', () => {
  const { files, workflows, rest } = setup();
  expect(checkWorkflowIntent(files, workflows, NOW)).toEqual([]);
  expect(checkLiveWorkflows(replayGh({ rest }), files)).toEqual([]);
});
it.each(['repository', 'path', 'ref', 'repository_id'] as const)(
  'refuses live workflow %s drift',
  (key) => {
    const { files, rest, rule } = setup();
    Object.assign(rule.rules[0]!.parameters.workflows[0]!, {
      [key]: key === 'repository_id' ? 99 : 'wrong',
    });
    expect(checkLiveWorkflows(replayGh({ rest }), files).length).toBeGreaterThan(0);
  }
);
it.each([
  'missing',
  'disabled',
  'bypass',
  'hidden bypass',
  'sha',
  'scope',
  'ref scope',
  'source identity',
  'repo identity',
  'create exemption',
  'duplicate',
])('refuses %s instead of certifying missing evidence', (fault) => {
  const { files, rule, rest } = setup();
  if (fault === 'missing') rest['orgs/o/rulesets?per_page=100&page=1'] = [];
  if (fault === 'disabled') rule.enforcement = 'disabled';
  if (fault === 'bypass') Object.assign(rule, { bypass_actors: [{ actor_id: 1 }] });
  if (fault === 'hidden bypass') Reflect.deleteProperty(rule, 'bypass_actors');
  if (fault === 'sha')
    Object.assign(rule.rules[0]!.parameters.workflows[0]!, { sha: 'a'.repeat(40) });
  if (fault === 'scope') Object.assign(rule.conditions.repository_name, { exclude: ['r'] });
  if (fault === 'ref scope') rule.conditions.ref_name.include = ['~ALL'];
  if (fault === 'source identity') rule.source = 'other';
  if (fault === 'repo identity') rest['repos/o/r'] = { id: 99, full_name: 'o/r' };
  if (fault === 'create exemption') rule.rules[0]!.parameters.do_not_enforce_on_create = true;
  if (fault === 'duplicate') rest['orgs/o/rulesets?per_page=100&page=1'] = [rule, rule];
  expect(checkLiveWorkflows(replayGh({ rest }), files).length).toBeGreaterThan(0);
});
it('paginates org rules and refuses unreadable org rules or details', () => {
  const { files, rule, rest } = setup();
  rest['orgs/o/rulesets?per_page=100&page=1'] = Array.from({ length: 100 }, (_, i) => ({
    id: 100 + i,
    name: 'other',
  }));
  rest['orgs/o/rulesets?per_page=100&page=2'] = [rule];
  expect(checkLiveWorkflows(replayGh({ rest }), files)).toEqual([]);
  rest['orgs/o/rulesets/7'] = new Error('HTTP 403');
  expect(checkLiveWorkflows(replayGh({ rest }), files)[0]!.message).toContain('failed');
});
it('marks a token that may not read org rules apart from a read that went wrong', () => {
  const { files, rest } = setup();
  rest['orgs/o/rulesets?per_page=100&page=1'] = new Error(
    'gh: Resource not accessible by integration (HTTP 403)'
  );
  const [refused] = checkLiveWorkflows(replayGh({ rest }), files);
  expect(refused).toMatchObject({ code: UNREADABLE_CODE });
  expect(refused!.message).toContain('failed');
  rest['orgs/o/rulesets?per_page=100&page=1'] = new Error('HTTP 502');
  expect(checkLiveWorkflows(replayGh({ rest }), files)[0]).toMatchObject({
    code: 'required-workflow/drift',
  });
});
it.each([
  'missing',
  'trigger',
  'paths',
  'branches',
  'types',
  'job-if',
  'step-if',
  'continue-on-error',
  'no jobs',
  'matrix-if',
])('local census refuses %s for a required workflow without relying on a context name', (fault) => {
  const { files, workflows, source } = setup();
  const wf = workflows.find((w) => w.path === source.path)!;
  if (fault === 'missing') source.path = '.github/workflows/missing.yml';
  if (fault === 'trigger') wf.triggers.delete('merge_group');
  if (fault === 'paths') wf.triggers.get('pull_request')!.paths = ['src/**'];
  if (fault === 'branches') wf.triggers.get('merge_group')!.branches = ['main'];
  if (fault === 'types') wf.triggers.get('pull_request')!.types = ['synchronize'];
  if (fault === 'job-if') wf.jobs[0]!.if = false;
  if (fault === 'step-if') wf.jobs[0]!.steps[0]!.if = false;
  if (fault === 'continue-on-error') wf.jobs[0]!.continueOnError = true;
  if (fault === 'no jobs') wf.jobs = [];
  if (fault === 'matrix-if')
    Object.assign(wf.jobs[0]!, { isMatrix: true, checkName: null, if: false });
  expect(checkWorkflowIntent(files, workflows, NOW).length).toBeGreaterThan(0);
});
it('collector includes workflow-only required sources with no required context', () => {
  const { workflows, source } = setup();
  expect(requiredWorkflowPaths(workflows, [], [{ ...source, enforcement: 'active' }])).toEqual([
    source.path,
  ]);
});
it.each(['evaluate', 'disabled'])(
  'collector does not count a %s source, which blocks no merge',
  (enforcement) => {
    const { workflows, source } = setup();
    expect(requiredWorkflowPaths(workflows, [], [{ ...source, enforcement }])).toEqual([]);
  }
);
it('a source with no enforcement field parses as active, so existing intent keeps counting', () => {
  const { files, source } = setup();
  const { enforcement: _omitted, ...legacy } = source;
  const parsed = RequiredChecksSchema.parse({ ...files.requiredChecks, workflows: [legacy] });
  expect(parsed.workflows[0]!.enforcement).toBe('active');
});
it('live census still refuses a source that is not active yet, whatever the intent says', () => {
  const { files, rule, rest } = setup();
  rule.enforcement = 'disabled';
  files.requiredChecks!.workflows = [
    { ...files.requiredChecks!.workflows[0]!, enforcement: 'disabled' },
  ];
  expect(checkLiveWorkflows(replayGh({ rest }), files).length).toBeGreaterThan(0);
});
it('schema rejects bypasses, malformed sources and unknown keys', () => {
  const { files, source } = setup();
  for (const patch of [
    { bypass_actors: [1] },
    { ref: 'main' },
    { path: 'elsewhere.yml' },
    { enforcement: 'on' },
    { unknown: true },
  ])
    expect(
      RequiredChecksSchema.safeParse({
        ...files.requiredChecks,
        workflows: [{ ...source, ...patch }],
      }).success
    ).toBe(false);
});
it('local census stays offline; --live is opt-in and returns nonzero on missing rule', () => {
  const { root, files } = setup();
  writeFileSync(path.join(root, 'ci/required-checks.json'), JSON.stringify(files.requiredChecks));
  runCensus({ root, now: NOW, fix: true });
  expect(runCensus({ root, now: NOW }).findings).toEqual([]);
  const messages: string[] = [];
  expect(
    main(['census'], { out: () => {}, err: () => {} }, root, {
      gh: () => {
        throw new Error('must stay offline');
      },
    })
  ).toBe(0);
  expect(
    main(
      ['census', '--live'],
      { out: (s) => messages.push(s), err: (s) => messages.push(s) },
      root,
      { gh: () => replayGh({ rest: {} }) }
    )
  ).toBe(1);
  expect(messages.join('')).toContain('failed');
});

it('census requires canary coverage even for workflow sources with only matrix jobs', () => {
  const spec = baseSpec();
  const wf = spec.workflows['lint.yml'];
  Object.assign((wf!.jobs as Record<string, object>)['lint']!, {
    strategy: { matrix: { os: ['ubuntu-latest'] } },
  });
  spec.requiredChecks.contexts = ['test'];
  Object.assign(spec.requiredChecks, {
    workflows: [
      {
        ruleset_name: 'Trusted workflow',
        repository: 'o/r',
        repository_id: 42,
        path: '.github/workflows/lint.yml',
        ref: 'refs/heads/main',
        bypass_actors: [],
      },
    ],
  });
  const root = writeRepo(spec);
  dirs.push(root);
  const configPath = path.join(root, 'ci/config.yaml');
  const config = parseYaml(readFileSync(configPath, 'utf8'));
  config.canary.workflows = config.canary.workflows.filter((f: string) => f !== 'lint.yml');
  delete config.canary.exempt['lint.yml'];
  writeFileSync(configPath, stringifyYaml(config));
  runCensus({ root, now: NOW, fix: true });
  expect(
    runCensus({ root, now: NOW }).findings.some(
      (f) => f.code === 'canary/required-unwatched' && f.where === 'lint.yml'
    )
  ).toBe(true);
});
