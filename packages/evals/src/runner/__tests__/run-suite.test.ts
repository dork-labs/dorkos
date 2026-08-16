/**
 * Suite wiring: a free `test-mode` run produces a `results.json` a reader can
 * trust, and the retry policy is threaded through WITHOUT changing what a normal
 * first-attempt run looks like.
 *
 * The transcript name is the assertion that matters. The retry writes a second
 * attempt under its own file so the first one survives; if that naming leaked
 * into attempt 1, every ordinary run would file its transcript under a name
 * nothing else looks for, and the `transcript` pointer in `results.json` would
 * quietly stop matching what CI attaches.
 *
 * WHAT THIS FILE DOES NOT COVER: a retry actually firing through `runSuite`.
 * That needs a real turn timeout, and forcing one on `test-mode` means picking a
 * `timeoutMs` that races the subscribe gate — a flaky test about flake handling
 * is worse than an honest gap. The retry policy itself is unit-tested against an
 * injected attempt function in `retry.test.ts`; this file only pins that
 * threading it through did not disturb the ordinary path.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import { RunSummarySchema, type EvalCase, type RuntimeTier } from '../../types.js';
import { selfTestCase } from '../../suite/selftest.js';
import { runSuite } from '../run-suite.js';
import { evaluateRunGate } from '../../report/summary.js';

// The local-sign-in probe shells out to the real `claude` binary; left real, a
// tier-mismatch test that boots a credentialed run on a machine that happens to
// be signed in could probe it for no reason (the case never runs either way,
// but resolveModelCredential still runs once per run before the per-case skip).
vi.mock('@dorkos/server/services/runtimes/claude-code/auth-probe', () => ({
  hasLocalClaudeLogin: vi.fn(async () => false),
}));
const mockedLocalLogin = vi.mocked(hasLocalClaudeLogin);

let outDir: string | undefined;

beforeEach(() => {
  mockedLocalLogin.mockResolvedValue(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (outDir) await rm(outDir, { recursive: true, force: true });
  outDir = undefined;
});

describe('runSuite', () => {
  it('runs a free case and writes a results.json that validates', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    const { summary, runDir, resultsPath } = await runSuite([selfTestCase], {
      tier: 'test-mode',
      outDir,
      runId: 'run-wiring',
    });

    expect(
      RunSummarySchema.safeParse(JSON.parse(await readFile(resultsPath, 'utf8'))).success
    ).toBe(true);

    const [result] = summary.results;
    expect(result.status).toBe('pass');
    // A first attempt is not a retry, and a free tier's $0 is measured, not missing.
    expect(result.retried).toBe(false);
    expect(result.costUnmetered).toBe(false);
    // The transcript pointer resolves to a file that is actually there.
    expect(result.transcript).toBe('harness-selftest.jsonl');
    expect((await stat(path.join(runDir, result.transcript ?? ''))).isFile()).toBe(true);
  });
});

/** A minimal case that never actually drives anything — only its declared tier matters. */
function fixtureCase(id: string, tier: RuntimeTier): EvalCase {
  return {
    id,
    title: `Fixture (${tier})`,
    prompt: '',
    runtimeTier: tier,
    costClass: tier === 'test-mode' ? 'free' : 'cheap',
    tags: ['core'],
    oracles: [],
  };
}

describe('tier mismatch classification (DOR-1228)', () => {
  it('skips a test-mode-only case on a credentialed request (downward) as skipped-wrong-tier, non-gating', async () => {
    // The regression this pins: `--suite core --tier claude-code-cheap` used to
    // run `widget-round-trip`-shaped cases anyway and let them fail as `error`
    // (a `409 SESSION_LOCKED`, or a case's own "test-mode only" throw) — which
    // GATES the run. A tier the case never declared must be an honest skip.
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-key');
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-downward-'));
    const { summary } = await runSuite([fixtureCase('needs-test-mode', 'test-mode')], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'downward',
      notify: () => {},
    });

    const [result] = summary.results;
    expect(result.status).toBe('skipped-wrong-tier');
    expect(result.oracleResults).toEqual([]);
    expect(result.costUsd).toBe(0);
    // The row names the tier the case NEEDS, not the one the run booted.
    expect(result.runtimeTier).toBe('test-mode');
    // And it does not GATE — a mismatched case is coverage for nothing,
    // never a case the run could fail.
    const gate = evaluateRunGate(summary);
    expect(gate.totalCases).toBe(0);
    expect(gate.gatingCases).toBe(0);
  });

  it('still skips a credentialed case on a test-mode request (upward) as skipped-wrong-tier', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-upward-'));
    const { summary } = await runSuite([fixtureCase('needs-credentialed', 'claude-code-cheap')], {
      tier: 'test-mode',
      outDir,
      runId: 'upward',
    });

    const [result] = summary.results;
    expect(result.status).toBe('skipped-wrong-tier');
    expect(result.runtimeTier).toBe('claude-code-cheap');
  });

  it('runs a case normally when its declared tier matches the requested one (no false skip)', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-match-'));
    const { summary } = await runSuite([selfTestCase], {
      tier: 'test-mode',
      outDir,
      runId: 'matched',
    });

    expect(summary.results[0]?.status).not.toBe('skipped-wrong-tier');
  });
});
