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
import { roomsHaltStopsCase } from '../../suite/rooms.js';
import { widgetRoundTripCase } from '../../suite/ui.js';
import { runSuite } from '../run-suite.js';
import { DEFAULT_CHEAP_MODEL } from '../harness-server.js';
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
/**
 * A private, empty `~/.claude` stand-in for THIS file's credentialed-tier
 * tests. `startChildProcessServer`'s launcher deliberately inherits the
 * parent env so the spawned server can find `PATH`/`HOME` and the `claude`
 * binary (`child-process-launcher.ts`) — which means a mocked
 * `hasLocalClaudeLogin` in THIS process protects nothing once a real
 * subprocess is spawned; the subprocess reads `$CLAUDE_CONFIG_DIR ?? ~/.claude`
 * on its own (`claude-config-dir.ts`). A measured fact in AGENTS.md: a fake
 * `ANTHROPIC_API_KEY` alone does not stop that subprocess from falling back to
 * and billing a real local sign-in. Pointing both vars at a directory that
 * cannot contain one is the actual guard (DOR-1228 review, Important 4) —
 * belt-and-suspenders alongside the credential-gate tests below, which are
 * designed to never boot a subprocess at all.
 */
let claudeHome: string | undefined;

beforeEach(async () => {
  mockedLocalLogin.mockResolvedValue(false);
  // Fail-closed by default: no pinned credential var, no local sign-in. A test
  // that needs a resolved credential sets one explicitly.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  claudeHome = await mkdtemp(path.join(tmpdir(), 'evals-suite-claude-home-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
  vi.stubEnv('HOME', claudeHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (outDir) await rm(outDir, { recursive: true, force: true });
  outDir = undefined;
  if (claudeHome) await rm(claudeHome, { recursive: true, force: true });
  claudeHome = undefined;
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

describe('the recorded model (DOR-1564)', () => {
  // Red when: `results.json` stops naming the model a credentialed run reached.
  // The tier does NOT identify it — `claude-code-cheap` answered by haiku-4-5
  // and by sonnet-5 gave opposite verdicts on the same build — so a run whose
  // only model evidence is somebody's memory cannot be re-read later.
  it('records the resolved model on a credentialed run, flag or default', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-model-'));
    const withFlag = await runSuite([fixtureCase('needs-test-mode', 'test-mode')], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'model-flag',
      model: 'claude-sonnet-5',
      notify: () => {},
    });
    expect(withFlag.summary.model).toBe('claude-sonnet-5');
    // It survives the schema, so it is on disk and not only in memory.
    expect(
      RunSummarySchema.parse(JSON.parse(await readFile(withFlag.resultsPath, 'utf8'))).model
    ).toBe('claude-sonnet-5');

    // No `--model`: the recorded value is the one the boot would apply, never
    // an empty field that reads as "unknown".
    const withDefault = await runSuite([fixtureCase('needs-test-mode', 'test-mode')], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'model-default',
      notify: () => {},
    });
    expect(withDefault.summary.model).toBe(DEFAULT_CHEAP_MODEL);
  });

  // Red when: a `test-mode` run starts claiming a model. It reaches none, and a
  // model name there would be a fact about nothing.
  it('records no model on a test-mode run', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-model-free-'));
    const { summary } = await runSuite([selfTestCase], {
      tier: 'test-mode',
      outDir,
      runId: 'model-test-mode',
    });
    expect(summary.model).toBeUndefined();
  });
});

/** A minimal case that never actually drives anything — only its declared tier (and flag) matter. */
function fixtureCase(
  id: string,
  tier: RuntimeTier,
  opts: { testModeOnly?: boolean } = {}
): EvalCase {
  return {
    id,
    title: `Fixture (${tier})`,
    prompt: '',
    runtimeTier: tier,
    ...(opts.testModeOnly !== undefined ? { testModeOnly: opts.testModeOnly } : {}),
    costClass: tier === 'test-mode' ? 'free' : 'cheap',
    tags: ['core'],
    oracles: [],
  };
}

describe('tier mismatch classification (DOR-1228)', () => {
  it('skips a testModeOnly case on a credentialed request (downward) as skipped-wrong-tier, non-gating', async () => {
    // The regression this pins: `--suite rooms --tier claude-code-cheap` used to
    // run `rooms-halt-stops-and-says-so` anyway and let it fail as `error` (its
    // own "test-mode only" scenario-guard throw) — which GATES the run. A tier
    // the case structurally cannot run on must be an honest skip instead.
    //
    // No credential is stubbed here on purpose: this fixture is skipped BEFORE
    // `runSuite` ever reaches the credential gate or a launcher, so the
    // file's fail-closed default (no env var, mocked local login = false, plus
    // the CLAUDE_CONFIG_DIR/HOME sandbox above) is what a REGRESSION here would
    // fall through to — a runner `error`, never a real boot.
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-downward-'));
    const { summary } = await runSuite(
      [fixtureCase('needs-test-mode', 'test-mode', { testModeOnly: true })],
      {
        tier: 'claude-code-cheap',
        outDir,
        runId: 'downward',
        notify: () => {},
      }
    );

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

  it('does NOT skip a plain `test-mode` case downward — only `testModeOnly` does (DOR-1228 review, Blocker 1)', async () => {
    // The bug the review caught: treating `runtimeTier: 'test-mode'` alone as
    // "skip downward" would have removed real coverage. `widget-round-trip` is
    // declared `test-mode` (free, deterministic) but is runtime-agnostic by
    // construction and MUST still be attempted on a credentialed tier — see the
    // real-case proof below. This fixture pins the same boundary in isolation.
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-downward-attempted-'));
    const { summary } = await runSuite([fixtureCase('plain-test-mode', 'test-mode')], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'downward-attempted',
      notify: () => {},
    });

    const [result] = summary.results;
    // Attempted, not skipped — and with no credential resolved (this file's
    // fail-closed default), it comes back a runner `error` rather than ever
    // booting a subprocess.
    expect(result.status).not.toBe('skipped-wrong-tier');
    expect(result.status).toBe('error');
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

  it('the REAL cases: rooms-halt is skipped-wrong-tier at claude-code-cheap, widget-round-trip is attempted/gating there (DOR-1228 review)', async () => {
    // No credential is stubbed (this file's fail-closed default), so
    // `widget-round-trip` — attempted, unlike `rooms-halt` — hits the
    // credential gate INSIDE `runEval` and returns a runner `error` before
    // `createSandbox`/`bootServerForTier` ever run (see run-eval.ts's
    // `credentialGateError`). That is what makes this safe to run in every
    // regular test invocation: nothing here can spawn a subprocess or reach a
    // model, with or without the CLAUDE_CONFIG_DIR/HOME sandbox above.
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-real-cases-'));
    const { summary } = await runSuite([roomsHaltStopsCase, widgetRoundTripCase], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'real-cases',
      notify: () => {},
    });

    const halt = summary.results.find((r) => r.id === roomsHaltStopsCase.id);
    const widget = summary.results.find((r) => r.id === widgetRoundTripCase.id);
    expect(halt?.status).toBe('skipped-wrong-tier');
    expect(widget?.status).not.toBe('skipped-wrong-tier');
    expect(widget?.status).toBe('error');
    expect(widget?.error).toContain('needs a way to reach a model');

    const gate = evaluateRunGate(summary);
    // rooms-halt is excluded entirely (never attempted); widget-round-trip is
    // the one case this run could have failed on.
    expect(gate.totalCases).toBe(1);
    expect(gate.gatingCases).toBe(1);
    expect(gate.failed).toBe(true);
    expect(gate.reason).toContain(widgetRoundTripCase.id);
  });
});

/**
 * The `real-provider` tier's run-level refusals — the things that must happen
 * BEFORE a sandbox, a server or a turn exists.
 *
 * These are separated from the credential-gate tests above because they are a
 * different kind of answer. A credential gate reports a per-case runner error and
 * still writes a `results.json`; a refusal writes nothing at all, because nothing
 * was attempted and there is no verdict to record. Both are fail-closed; only one
 * of them has anything to report.
 */
describe('runSuite on the paid real-provider tier', () => {
  /** A minimal cross-runtime case, so these tests never depend on the real suite. */
  const paidCase: EvalCase = {
    id: 'paid-probe',
    title: 'A paid case that must never actually run in these tests',
    prompt: 'ping',
    runtimeTier: 'real-provider',
    costClass: 'cheap',
    tags: ['chat'],
    oracles: [],
  };

  it('refuses before booting anything when nobody set the opt-in flag', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // A key is present and deliberately not enough: the flag is read at module
    // scope in `runner/credentials.ts` and is unset in this process.
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-not-a-real-key');
    await expect(
      runSuite([paidCase], {
        tier: 'real-provider',
        outDir: outDir as string,
        runId: 'paid-no-opt-in',
        notify: () => {},
      })
    ).rejects.toThrow(/needs you to say so/);

    // Nothing was written, because nothing was attempted.
    await expect(stat(path.join(outDir as string, 'paid-no-opt-in'))).rejects.toThrow();
  });

  it('refuses a CHEAP-tier run that reaches a paid provider through --runtime opencode', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // THE COMMAND A REVIEWER WALKED THROUGH THE OLD GATE WITH:
    //   pnpm evals -- --suite chat --tier claude-code-cheap \
    //     --runtime opencode --model openrouter/qwen/qwen3.7-flash
    // The tier string says `claude-code-cheap`, so a gate keyed on the tier let
    // it straight through — and it spent real money on OpenRouter, then recorded
    // `credentialSource: 'anthropic-…'` on the way out. A key is exported here to
    // make the point: the refusal is about the missing DECISION, not the missing
    // instrument.
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-not-a-real-key');
    await expect(
      runSuite([{ ...paidCase, runtimeTier: 'claude-code-cheap' }], {
        tier: 'claude-code-cheap',
        runtime: 'opencode',
        model: 'openrouter/qwen/qwen3.7-flash',
        outDir: outDir as string,
        runId: 'cheap-tier-paid-provider',
        notify: () => {},
      })
    ).rejects.toThrow(/needs you to say so/);

    // Nothing was written, because nothing was attempted.
    await expect(stat(path.join(outDir as string, 'cheap-tier-paid-provider'))).rejects.toThrow();
  });

  it('refuses a cheap-tier run that names a provider explicitly, with no runtime at all', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // The other arm of the same rule: naming a provider IS asking to spend on
    // one, whatever tier or runtime is written beside it.
    await expect(
      runSuite([{ ...paidCase, runtimeTier: 'claude-code-cheap' }], {
        tier: 'claude-code-cheap',
        provider: 'openrouter',
        outDir: outDir as string,
        runId: 'cheap-tier-explicit-provider',
        notify: () => {},
      })
    ).rejects.toThrow(/needs you to say so/);
  });

  it('leaves an ordinary claude-code run on the Anthropic credential ladder', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // The negative control that keeps the rule above from being "refuse
    // everything": a plain credentialed run names no provider, so it asks the
    // Anthropic question and reaches the ordinary fail-closed error rather than
    // the spend refusal.
    const { summary } = await runSuite([{ ...paidCase, runtimeTier: 'claude-code-cheap' }], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'ordinary-credentialed',
      notify: () => {},
    });
    expect(summary.results[0]?.status).toBe('error');
    expect(summary.results[0]?.error).toContain('needs a way to reach a model');
    expect(summary.provider).toBeUndefined();
  });

  it('refuses the docker isolation tier rather than degrading to the bare host', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // Answered BEFORE the money question, which is what makes this assertable at
    // all in-process: the opt-in flag is read at module scope and is unset here,
    // so a docker check placed after it could never be reached by a test.
    await expect(
      runSuite([paidCase], {
        tier: 'real-provider',
        outDir: outDir as string,
        runId: 'paid-docker',
        isolation: 'docker',
        notify: () => {},
      })
    ).rejects.toThrow(/no network at all/);
  });
});

/**
 * A case that names the runtime it is ABOUT is skipped on a run that booted a
 * different one — the runtime dimension of the same enforced-rather-than-
 * described rule the tier already carries.
 */
describe('runSuite runtime selection', () => {
  /** A case that only means something on OpenCode. */
  const openCodeOnly: EvalCase = {
    id: 'opencode-only-probe',
    title: 'A case written about OpenCode specifically',
    prompt: 'ping',
    runtimeTier: 'claude-code-cheap',
    runtime: 'opencode',
    costClass: 'cheap',
    tags: ['chat'],
    oracles: [],
  };

  /** A cross-runtime case: no declared runtime, runs wherever it is pointed. */
  const crossRuntime: EvalCase = {
    id: 'cross-runtime-probe',
    title: 'A case that means the same thing on every runtime',
    prompt: 'ping',
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    tags: ['chat'],
    oracles: [],
  };

  it('skips a case written about another runtime, and runs the cross-runtime one', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // No credential resolves in this file (see beforeEach), so the case that is
    // NOT skipped stops at the credential gate without booting a server — which
    // is exactly what makes this test free and hermetic.
    const { summary } = await runSuite([openCodeOnly, crossRuntime], {
      tier: 'claude-code-cheap',
      runtime: 'claude-code',
      outDir,
      runId: 'runtime-mismatch',
      notify: () => {},
    });

    const skipped = summary.results.find((r) => r.id === openCodeOnly.id);
    const ran = summary.results.find((r) => r.id === crossRuntime.id);
    expect(skipped?.status).toBe('skipped-wrong-runtime');
    // The row names the runtime the CASE would need, not the one the run booted —
    // otherwise the row says nothing a reader can act on.
    expect(skipped?.runtime).toBe('opencode');
    expect(ran?.status).toBe('error');
    expect(summary.runtime).toBe('claude-code');

    // A never-started case neither gates nor counts as coverage.
    const gate = evaluateRunGate(summary);
    expect(gate.totalCases).toBe(1);
  });

  it('records the runtime and model the run was pointed at', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    // Deliberately a NON-SPENDING shape: no provider named and a runtime that
    // fronts none, so this exercises the recording without tripping the spend
    // gate. Naming a provider here would (correctly) refuse — that is what the
    // 'refuses a cheap-tier run that names a provider explicitly' case above
    // asserts, and `summary.provider` is covered on the paid path where it is
    // the only place it can honestly be set.
    const { summary } = await runSuite([crossRuntime], {
      tier: 'claude-code-cheap',
      runtime: 'codex',
      model: 'some-model',
      outDir,
      runId: 'triple',
      notify: () => {},
    });
    expect(summary.runtime).toBe('codex');
    expect(summary.model).toBe('some-model');
    expect(summary.provider).toBeUndefined();
  });
});

/**
 * The spend ceiling follows the same predicate as the gate.
 *
 * Keyed on the tier alone it did not: an armed `--tier claude-code-cheap
 * --runtime opencode` run spent on OpenRouter under the $3 credentialed ceiling
 * instead of the $0.50 tripwire — the same tier/money confusion as the gate
 * itself, one layer down, and the layer that decides how much a runaway loop can
 * burn before anything stops it.
 */
describe('the paid spend ceiling', () => {
  const crossRuntime: EvalCase = {
    id: 'ceiling-probe',
    title: 'A case used only to read the ceiling off the summary',
    prompt: 'ping',
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    tags: ['chat'],
    oracles: [],
  };

  it('stays at the credentialed default for a run that reaches no external provider', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    const { summary } = await runSuite([crossRuntime], {
      tier: 'claude-code-cheap',
      outDir,
      runId: 'ceiling-anthropic',
      notify: () => {},
    });
    expect(summary.budgetUsd).toBe(3);
  });

  it('honours an explicit --budget over either default', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'evals-suite-'));
    const { summary } = await runSuite([crossRuntime], {
      tier: 'claude-code-cheap',
      budgetUsd: 1.25,
      outDir,
      runId: 'ceiling-explicit',
      notify: () => {},
    });
    expect(summary.budgetUsd).toBe(1.25);
  });
});
