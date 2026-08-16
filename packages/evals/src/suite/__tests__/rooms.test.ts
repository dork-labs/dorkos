/**
 * What the `rooms` suite promises about ITSELF: which cases gate, which spend,
 * and that the spending ones cannot run without somebody deciding to pay.
 *
 * The money question is the reason this file exists. `pnpm evals:local` runs the
 * `core` tag against a real model, so a case's TAGS decide whether it spends —
 * and a structural case that drifted into `core` would quietly bill every local
 * run for something that was supposed to be free. That is pinned here rather
 * than left to review.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import { BudgetTracker } from '../../runner/budget.js';
import { runEval } from '../../runner/run-eval.js';
import { runSuite } from '../../runner/run-suite.js';
import { evaluateRunGate } from '../../report/summary.js';
import { selectSuite } from '../index.js';
import { roomsStructuralCases } from '../rooms.js';
import { roomsCredentialedCases } from '../rooms-recall.js';

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

describe('the rooms suite registry', () => {
  it('is reachable as `--suite rooms`, and holds both tiers', () => {
    const selected = selectSuite('rooms');
    expect(selected).toHaveLength(roomsStructuralCases.length + roomsCredentialedCases.length);
    for (const evalCase of [...roomsStructuralCases, ...roomsCredentialedCases]) {
      expect(selected.map((c) => c.id)).toContain(evalCase.id);
    }
  });

  it('gives every case a unique id that `--suite <case-id>` can select', () => {
    for (const evalCase of [...roomsStructuralCases, ...roomsCredentialedCases]) {
      expect(selectSuite(evalCase.id).map((c) => c.id)).toEqual([evalCase.id]);
    }
  });

  it('drives a room in every case, since no rooms oracle can read a session stream', () => {
    for (const evalCase of [...roomsStructuralCases, ...roomsCredentialedCases]) {
      expect(evalCase.roomScript, evalCase.id).toBeDefined();
      expect(evalCase.prompt, evalCase.id).toBe('');
      expect(evalCase.oracles.length, evalCase.id).toBeGreaterThan(0);
    }
  });
});

describe('the structural tier', () => {
  it('is free, deterministic, and gates', () => {
    for (const evalCase of roomsStructuralCases) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('test-mode');
      expect(evalCase.costClass, evalCase.id).toBe('free');
      // Gating is the point of this tier: a quarantined structural case would
      // run, report, and never be able to fail anything.
      expect(evalCase.quarantined ?? false, evalCase.id).toBe(false);
    }
  });

  it('stays OUT of `core`, which `pnpm evals:local` runs against a real model', () => {
    for (const evalCase of roomsStructuralCases) {
      expect(evalCase.tags, evalCase.id).toContain('rooms');
      expect(evalCase.tags, evalCase.id).not.toContain('core');
      expect(evalCase.tags, evalCase.id).not.toContain('smoke');
    }
    expect(selectSuite('core').map((c) => c.id)).not.toContain(roomsStructuralCases[0]?.id);
  });
});

describe('the credentialed tier', () => {
  it('is quarantined, budget-capped, and asks for a real model', () => {
    for (const evalCase of roomsCredentialedCases) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('claude-code-cheap');
      expect(evalCase.costClass, evalCase.id).toBe('cheap');
      // Quarantined: it reports and never gates until credentialed runs promote
      // it, which is a human decision on the evidence (README).
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.perEvalCeilingUsd, evalCase.id).toBeGreaterThan(0);
      expect(evalCase.tags, evalCase.id).toContain('rooms');
      expect(evalCase.tags, evalCase.id).not.toContain('core');
    }
  });

  it('covers the X-row probes chat-capabilities §7 asks for, minus the two it cannot reach', () => {
    const ids = roomsCredentialedCases.map((c) => c.id);
    // X-01 … X-06, plus restraint (M-04 / A-02), react-not-reply (A-06,
    // DOR-1234), the injection eval (A-15), and the comprehension half of RP8's
    // gathering (DOR-1231) — the last of which is not an X-row, and is here
    // because only a real model can answer three questions at once.
    expect(ids).toEqual([
      'rooms-recall-member-said',
      'rooms-recall-roster-handles',
      'rooms-recall-thread-subject',
      'rooms-recall-acknowledgments',
      'rooms-recall-attachment',
      'rooms-recall-honest-refusal',
      'rooms-restraint-ambient-chatter',
      'rooms-ack-only-reacts-not-replies',
      'rooms-adversarial-injection',
      'rooms-burst-answered-in-full',
    ]);
    // X-07 (bridged) and X-08 (post-compaction) are documented gaps, not cases.
    // If either ever lands, this list changes deliberately rather than by drift.
    expect(ids).toHaveLength(10);
  });

  it('is NEVER started by a test-mode run — no case here can report pass or fail without a model', async () => {
    // The false-green this pins: `--suite rooms --tier test-mode` used to run
    // all twelve cases, and `rooms-adversarial-injection` reported PASS — a
    // scripted echo obeys no injected instruction, so every oracle went green
    // about a security property nothing had exercised.
    runDir = await mkdtemp(path.join(tmpdir(), 'evals-rooms-tier-'));
    const { summary } = await runSuite(roomsCredentialedCases, {
      tier: 'test-mode',
      outDir: runDir,
      runId: 'rooms-tier',
      notify: () => {},
    });

    expect(summary.results).toHaveLength(roomsCredentialedCases.length);
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
    runDir = await mkdtemp(path.join(tmpdir(), 'evals-rooms-gate-'));
    const tracker = new BudgetTracker({ runBudgetUsd: 1 });
    const probe = roomsCredentialedCases[0];
    expect(probe).toBeDefined();

    const result = await runEval(probe!, {
      tier: 'claude-code-cheap',
      runId: 'rooms-gate',
      runDir,
      tracker,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('ANTHROPIC_API_KEY');
    expect(result.error).toContain('claude auth login');
    // It refused before booting, so nothing was spent and nothing is unmeasured.
    expect(result.costUsd).toBe(0);
    expect(result.costUnmetered).toBe(false);
    // And no oracle ran: a security case that "passed" without a model would be
    // the worst possible green.
    expect(result.oracleResults).toEqual([]);
  });
});
