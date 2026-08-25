/**
 * What the `memory` suite promises about ITSELF: which cases exist, that none of
 * them can gate, and that none of them can run — or spend — without somebody
 * deciding to pay.
 *
 * The money question is why this file exists, and it is sharper here than for
 * the rooms suite. Every case in `memory` is credentialed, so a tag that drifted
 * into `core` would bill `pnpm evals:local` on every run, and a case that
 * reported a verdict on `test-mode` would be claiming a security and recall
 * property nothing had exercised. Both are pinned below rather than left to
 * review.
 *
 * The fixture arithmetic is pinned too. `nearCapMemory()` decides whether X-12
 * tests anything at all: seeded over the cap and the case fails a check it
 * manufactured; seeded with too much headroom and the write succeeds outright
 * and the probe quietly stops being about consolidation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MEMORY_MAX_CHARS } from '@dorkos/shared/convention-files';
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import { BudgetTracker } from '../../runner/budget.js';
import { runEval } from '../../runner/run-eval.js';
import { runSuite } from '../../runner/run-suite.js';
import { evaluateRunGate } from '../../report/summary.js';
import { selectSuite } from '../index.js';
import { memoryCases, nearCapMemory } from '../memory.js';

// The local-sign-in probe shells out to the real `claude` binary. Left real, the
// credential-gate test below would boot a credentialed server and SPEND on a
// machine that happens to be signed in — which is the exact thing it exists to
// prove cannot happen by accident.
vi.mock('@dorkos/server/services/runtimes/claude-code/auth-probe', () => ({
  hasLocalClaudeLogin: vi.fn(async () => false),
}));
const mockedLocalLogin = vi.mocked(hasLocalClaudeLogin);

let runDir: string | undefined;

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  mockedLocalLogin.mockResolvedValue(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = undefined;
});

describe('the memory suite registry', () => {
  it('is reachable as `--suite memory`, and holds the three Phase 1 probes', () => {
    expect(selectSuite('memory').map((c) => c.id)).toEqual([
      'memory-recall-cross-surface',
      'memory-cap-consolidation',
      'memory-poisoned-note',
    ]);
    // X-10 and X-13 land with Phase 2. If either arrives, this list changes
    // deliberately rather than by drift.
    expect(memoryCases).toHaveLength(3);
  });

  it('gives every case a unique id that `--suite <case-id>` can select', () => {
    for (const evalCase of memoryCases) {
      expect(selectSuite(evalCase.id).map((c) => c.id)).toEqual([evalCase.id]);
    }
  });

  it('drives its surfaces from a room script, since a prompt turn cannot be the agent', () => {
    // A prompt turn always runs in the sandbox `projectCwd`, which hosts no
    // agent — so `memory_write` would be refused with `no-agent` and every case
    // would measure the refusal instead of the feature. Each case drives its own
    // direct session, at the agent's own directory, from inside `roomScript`.
    for (const evalCase of memoryCases) {
      expect(evalCase.roomScript, evalCase.id).toBeDefined();
      expect(evalCase.prompt, evalCase.id).toBe('');
      expect(evalCase.seed, evalCase.id).toBeDefined();
      expect(evalCase.oracles.length, evalCase.id).toBeGreaterThan(0);
    }
  });

  it('is quarantined, budget-capped, asks for a real model, and stays OUT of `core`', () => {
    for (const evalCase of memoryCases) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('claude-code-cheap');
      expect(evalCase.costClass, evalCase.id).toBe('cheap');
      // Quarantined: it reports and never gates until credentialed runs promote
      // it, which is a human decision on the evidence (README).
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.perEvalCeilingUsd, evalCase.id).toBeGreaterThan(0);
      expect(evalCase.tags, evalCase.id).toContain('memory');
      // `pnpm evals:local` runs `core` against a real model. A memory case that
      // drifted into it would bill every local run for a probe nobody selected.
      expect(evalCase.tags, evalCase.id).not.toContain('core');
      expect(evalCase.tags, evalCase.id).not.toContain('smoke');
    }
    const coreIds = selectSuite('core').map((c) => c.id);
    for (const evalCase of memoryCases) expect(coreIds).not.toContain(evalCase.id);
  });
});

describe('the X-12 near-cap fixture', () => {
  it('seeds UNDER the cap, within one short note of it, and repeats no line', () => {
    const seeded = nearCapMemory();

    // Over the cap and the case fails a check it manufactured, before the model
    // does anything.
    expect(seeded.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
    // Too much headroom and the obvious write just succeeds, so the probe stops
    // being about consolidation. One short note is ~42 characters and the
    // provenance suffix alone is ~28 of them.
    expect(MEMORY_MAX_CHARS - seeded.length).toBeLessThan(50);

    // Consolidation goes through `replace`/`remove`, and both refuse text that
    // matches twice. Identical notes would make the tidy-up impossible for a
    // reason that has nothing to do with the model.
    const notes = seeded.split('\n').filter((line) => line.startsWith('- '));
    expect(notes.length).toBeGreaterThan(50);
    expect(new Set(notes).size).toBe(notes.length);

    // Deterministic: same bytes every run, so a red is about the model.
    expect(nearCapMemory()).toBe(seeded);
  });
});

describe('the credential and tier gates', () => {
  it('is NEVER started by a test-mode run — no case here can report pass or fail without a model', async () => {
    // The false green this pins: a scripted echo saves nothing, recalls nothing
    // and obeys nothing, so all three cases would report green about properties
    // nothing had exercised. `rooms-adversarial-injection` did exactly that
    // before the runner enforced the declared tier.
    runDir = await mkdtemp(path.join(tmpdir(), 'evals-memory-tier-'));
    const { summary } = await runSuite(memoryCases, {
      tier: 'test-mode',
      outDir: runDir,
      runId: 'memory-tier',
      notify: () => {},
    });

    expect(summary.results).toHaveLength(memoryCases.length);
    for (const result of summary.results) {
      expect(result.status, result.id).toBe('skipped-wrong-tier');
      expect(result.oracleResults, result.id).toEqual([]);
      expect(result.costUsd, result.id).toBe(0);
      // The row names the tier the case NEEDS, not the one the run booted.
      expect(result.runtimeTier, result.id).toBe('claude-code-cheap');
    }
    // Stated as the property, not only as the enumeration: nothing here may
    // carry a verdict on this tier.
    expect(summary.results.some((r) => r.status === 'pass' || r.status === 'fail')).toBe(false);
    expect(summary.totalCostUsd).toBe(0);

    // And a run that started nothing must FAIL rather than report a green with
    // no coverage behind it.
    const gate = evaluateRunGate(summary);
    expect(gate.failed).toBe(true);
    expect(gate.gatingCases).toBe(0);
    expect(gate.reason).toContain('credentialed runtime');
  }, 30_000);

  it('REFUSES TO RUN with no credential — the gate that keeps a run from spending by accident', async () => {
    // No API key, no subscription token, `claude` not signed in. Every case here
    // must come back a runner `error` BEFORE anything boots: never a false pass,
    // and never a quiet downgrade to the free tier.
    runDir = await mkdtemp(path.join(tmpdir(), 'evals-memory-gate-'));

    for (const evalCase of memoryCases) {
      const result = await runEval(evalCase, {
        tier: 'claude-code-cheap',
        runId: 'memory-gate',
        runDir,
        tracker: new BudgetTracker({ runBudgetUsd: 1 }),
        transcriptName: `${evalCase.id}.gate.jsonl`,
      });

      expect(result.status, evalCase.id).toBe('error');
      expect(result.error, evalCase.id).toContain('ANTHROPIC_API_KEY');
      expect(result.error, evalCase.id).toContain('claude auth login');
      // It refused before booting, so nothing was spent and nothing is unmeasured.
      expect(result.costUsd, evalCase.id).toBe(0);
      expect(result.costUnmetered, evalCase.id).toBe(false);
      // And no oracle ran: a security case that "passed" without a model would
      // be the worst possible green.
      expect(result.oracleResults, evalCase.id).toEqual([]);
    }
  });
});
