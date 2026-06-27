/**
 * Contract suite for the built oracle CLI scripts (`.agents/flow/scripts/*.mjs`,
 * ADR-0294 / tasks 1.2-1.3). Each script is spawned as a real subprocess with a
 * fixture JSON payload on stdin; we assert its stdout JSON and exit code.
 *
 * The keystone is the dispatch **reproduce-the-oracle** test: it feeds the script
 * the SAME fixture an existing `classifyDispatchOutcome` unit test uses and
 * asserts the script's output equals the oracle's direct output — proving the
 * compiled `.mjs` reproduces the in-process oracle with no drift.
 *
 * `beforeAll` rebuilds the scripts from source so the suite always exercises
 * fresh artifacts (no stale-bundle drift); the build is idempotent and writes
 * only the five named outputs.
 *
 * @see specs/flow-marketplace-package (the /flow plugin packaging spec)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CalibrationSchema,
  CircuitBreakerSchema,
  DispatchSchema,
  GatesSchema,
  OwnershipSchema,
  RecoverySchema,
  WipCapSchema,
} from '../config-schema.js';
import { classifyDispatchOutcome, type DispatchOptions } from '../dispatch.js';
import { resolveInvolvement, type DecisionDescriptor } from '../calibration.js';
import { evaluateAutoMerge, planApprovalRequired, tripsCircuitBreaker } from '../gates.js';
import type { MergeState, UnitUsage } from '../gates.js';
import { recoverOrphan, type RecoveryContext } from '../flow-run.js';
import type { WorkItem } from '../work-item.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> src -> engine
const ENGINE_DIR = path.resolve(here, '..', '..');
// engine -> flow -> scripts
const SCRIPTS_DIR = path.resolve(ENGINE_DIR, '..', 'scripts');

/** Spawn a built oracle script, returning its exit code + captured streams. */
function runScript(
  name: string,
  opts: { stdin?: string; args?: readonly string[] } = {}
): { status: number | null; stdout: string; stderr: string } {
  const scriptPath = path.join(SCRIPTS_DIR, `${name}.mjs`);
  const res = spawnSync(process.execPath, [scriptPath, ...(opts.args ?? [])], {
    input: opts.stdin ?? '',
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Build a fully-formed, dispatchable WorkItem with overridable fields. */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    identifier: overrides.identifier,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['agent/ready'],
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => {
  // Rebuild the artifacts so the suite tests current source, not a stale bundle.
  execFileSync(process.execPath, ['build.mjs'], { cwd: ENGINE_DIR, stdio: 'pipe' });
}, 60_000);

describe('built oracle scripts exist', () => {
  it('emits all five named scripts into .agents/flow/scripts/', () => {
    for (const name of ['dispatch', 'involvement', 'gates', 'recovery', 'validate-config']) {
      expect(existsSync(path.join(SCRIPTS_DIR, `${name}.mjs`))).toBe(true);
    }
  });
});

describe('dispatch.mjs', () => {
  // Mirrors the dispatch-outcome.test.ts case (d): one agent/ready item plus two
  // shapeable items behind the readiness gate. Ownership crosses the JSON
  // boundary as a precomputed `ownershipOf` map (callbacks cannot serialize).
  const items = [
    makeItem({ identifier: 'DOR-READY' }),
    makeItem({ identifier: 'DOR-SHAPE-1', labels: [] }),
    makeItem({ identifier: 'DOR-SHAPE-2', labels: ['stage/triage'] }),
  ];
  const config = {
    dispatch: DispatchSchema.parse({}),
    ownership: OwnershipSchema.parse({}),
    wipCap: WipCapSchema.parse({}),
  };
  const opts: DispatchOptions = {
    ownershipOf: {
      'DOR-READY': 'unassigned',
      'DOR-SHAPE-1': 'unassigned',
      'DOR-SHAPE-2': 'unassigned',
    },
  };

  it('reproduces the classifyDispatchOutcome oracle exactly (no drift)', () => {
    // The oracle, called directly in-process.
    const expected = classifyDispatchOutcome(items, config, opts);

    // The same fixture, through the compiled script.
    const { status, stdout } = runScript('dispatch', {
      stdin: JSON.stringify({ items, config, opts }),
    });

    expect(status).toBe(0);
    const actual = JSON.parse(stdout);
    // Equal to the oracle output as it crosses the JSON boundary (the script's
    // sole transform). This is the reproduce-the-oracle contract.
    expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
    // And a readable spot-check of the keystone signals.
    expect(actual.picked.map((p: WorkItem) => p.identifier)).toEqual(['DOR-READY']);
    expect(actual).toMatchObject({ eligibleCount: 1, shapeableCount: 2, starved: false });
  });

  it('--help prints the input/output shape and exits 0', () => {
    const { status, stdout } = runScript('dispatch', { args: ['--help'] });
    expect(status).toBe(0);
    expect(stdout).toContain('"items"');
    expect(stdout).toContain('DispatchOutcome');
  });

  it('reads from --input <path> as well as stdin', () => {
    // A round-trip through a temp file proves the --input path is honored.
    const tmp = path.join(ENGINE_DIR, '.dispatch-fixture.tmp.json');
    writeFileSync(tmp, JSON.stringify({ items, config, opts }), 'utf8');
    try {
      const { status, stdout } = runScript('dispatch', { args: ['--input', tmp] });
      expect(status).toBe(0);
      expect(JSON.parse(stdout).eligibleCount).toBe(1);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('exits 1 on invalid (non-JSON) input', () => {
    const { status, stderr } = runScript('dispatch', { stdin: 'not json' });
    expect(status).toBe(1);
    expect(stderr).toContain('invalid input');
  });

  it('exits 1 on structurally invalid input (missing items)', () => {
    const { status } = runScript('dispatch', { stdin: JSON.stringify({ config }) });
    expect(status).toBe(1);
  });
});

describe('involvement.mjs', () => {
  const calibration = CalibrationSchema.parse({});

  it('reproduces resolveInvolvement for a floor trigger (stop-and-ask)', () => {
    const decision: DecisionDescriptor = {
      floorTriggers: ['secrets-or-spend'],
      reversibility: 'reversible',
      confidence: 'confident',
      stage: 'execution',
    };
    const expected = resolveInvolvement(decision, calibration);
    const { status, stdout } = runScript('involvement', {
      stdin: JSON.stringify({ decision, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('reproduces resolveInvolvement for reversible+confident (proceed-silently)', () => {
    const decision: DecisionDescriptor = {
      reversibility: 'reversible',
      confidence: 'confident',
      stage: 'execution',
    };
    const expected = resolveInvolvement(decision, calibration);
    const { status, stdout } = runScript('involvement', {
      stdin: JSON.stringify({ decision, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).behavior).toBe('proceed-silently');
  });
});

describe('gates.mjs', () => {
  const gates = GatesSchema.parse({});
  const calibration = CalibrationSchema.parse({});

  it('planApproval reproduces planApprovalRequired (off by default)', () => {
    const expected = planApprovalRequired(gates);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'planApproval', gates }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toBe(expected);
    expect(JSON.parse(stdout)).toBe(false);
  });

  it('circuitBreaker reproduces tripsCircuitBreaker (wall-clock trip)', () => {
    const usage: UnitUsage = { estimateMs: 1000, elapsedMs: 5000, tokensUsed: 10 };
    const circuitBreaker = CircuitBreakerSchema.parse({});
    const expected = tripsCircuitBreaker(usage, circuitBreaker);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'circuitBreaker', usage, circuitBreaker }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).reason).toBe('wall-clock');
  });

  it('autoMerge reproduces evaluateAutoMerge (clean + green + no drift -> merge)', () => {
    const state: MergeState = {
      mergeable: 'clean',
      ci: 'green',
      functionalChange: false,
      attemptCount: 1,
    };
    const expected = evaluateAutoMerge(state, gates, calibration);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'autoMerge', state, gates, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).kind).toBe('merge');
  });

  it('exits 1 on an unknown gate discriminator', () => {
    const { status } = runScript('gates', { stdin: JSON.stringify({ gate: 'nope' }) });
    expect(status).toBe(1);
  });
});

describe('recovery.mjs', () => {
  const recovery = RecoverySchema.parse({});
  const ctx: RecoveryContext = { worktreeExists: true, sessionLogIntact: true };

  it('reproduces recoverOrphan for needs-input (skip, never reclaimed)', () => {
    const expected = recoverOrphan('needs-input', null, ctx, recovery);
    const { status, stdout } = runScript('recovery', {
      stdin: JSON.stringify({ signal: 'needs-input', run: null, ctx, recovery }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).kind).toBe('skip');
  });

  it('exits 2 on an oracle invariant violation (claimed-no-worker with run: null)', () => {
    const { status, stderr } = runScript('recovery', {
      stdin: JSON.stringify({ signal: 'claimed-no-worker', run: null, ctx, recovery }),
    });
    expect(status).toBe(2);
    expect(stderr).toContain('oracle invariant');
  });
});

describe('validate-config.mjs', () => {
  it('accepts an empty object and returns the fully-resolved config (exit 0)', () => {
    const { status, stdout } = runScript('validate-config', { stdin: '{}' });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.config.tracker).toBe('linear');
    expect(out.config.gates.planApproval).toBe(false);
  });

  it('rejects an invalid config with errors and exits 1', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({ tracker: 'jira' }),
    });
    expect(status).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(Array.isArray(out.errors)).toBe(true);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('exits 1 on non-JSON input', () => {
    const { status, stdout } = runScript('validate-config', { stdin: 'garbage' });
    expect(status).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
  });
});
