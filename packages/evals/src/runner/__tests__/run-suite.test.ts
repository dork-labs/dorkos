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
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunSummarySchema } from '../../types.js';
import { selfTestCase } from '../../suite/selftest.js';
import { runSuite } from '../run-suite.js';

let outDir: string | undefined;

afterEach(async () => {
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
