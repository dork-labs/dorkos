/**
 * Deterministic guard for the `design-your-own-interview` case — its SEED and
 * its ORACLES, without a model. The eval's real run needs a credentialed model
 * (the interview is model behavior); this test proves the plumbing around it:
 * the seed lays down a valid newborn scaffold, and each oracle has a genuine
 * pass AND fail (so a broken always-pass oracle is caught, per the harness's
 * own oracle-test discipline). It simulates the interview's OUTCOME by writing
 * the soul the agent would author — never asserting on model prose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSoulContent } from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { EvalSandbox, OracleContext, OracleResult } from '../../types.js';
import { designYourOwnInterviewCase } from '../agents.js';

let sandbox: EvalSandbox;
let root: string;

/** An OracleContext over the seeded sandbox (the interview asserts on files only). */
function ctx(): OracleContext {
  return { sandbox, baseUrl: 'http://unused', sessionId: 's', frames: [] };
}

/** Run every oracle on the case and return their results, in order. */
function runOracles(): Promise<OracleResult[]> {
  return Promise.all(designYourOwnInterviewCase.oracles.map((o) => o(ctx())));
}

/** The seeded agent's SOUL.md path. */
function soulFile(): string {
  return path.join(sandbox.projectCwd, '.dork', 'SOUL.md');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'evals-interview-'));
  sandbox = { dorkHome: path.join(root, '.dork'), projectCwd: path.join(root, 'project') };
  // The seed itself creates projectCwd/.dork — no pre-mkdir needed.
  await designYourOwnInterviewCase.seed!(sandbox);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('design-your-own-interview case metadata', () => {
  it('is a credentialed judgment case in the core suite', () => {
    expect(designYourOwnInterviewCase.id).toBe('design-your-own-interview');
    expect(designYourOwnInterviewCase.runtimeTier).toBe('claude-code-cheap');
    expect(designYourOwnInterviewCase.tags).toContain('core');
    // Turn 1 is the real interview kickoff instruction, followed by human answers.
    expect(Array.isArray(designYourOwnInterviewCase.prompt)).toBe(true);
    expect(designYourOwnInterviewCase.prompt[0]).toContain('.dork/SOUL.md');
  });
});

describe('seedNewbornAgent', () => {
  it('lays down a default SOUL.md with intact trait markers to rewrite', async () => {
    const soul = await readFile(soulFile(), 'utf8');
    expect(soul).toContain('<!-- TRAITS:START -->');
    expect(soul).toContain('<!-- TRAITS:END -->');
    // The seed prose is the generic default the interview must replace.
    expect(soul).toContain('coding assistant');
  });
});

describe('interview outcome oracles', () => {
  it('FAIL on the untouched scaffold — the soul was not authored yet', async () => {
    const results = await runOracles();
    const byLabel = Object.fromEntries(results.map((r) => [r.label, r.passed]));
    // Trait markers are present in the scaffold, and nothing outside .dork exists…
    expect(results.find((r) => r.label.includes('trait markers'))?.passed).toBe(true);
    expect(results.find((r) => r.label.includes('offer-not-action'))?.passed).toBe(true);
    // …but the persona is still the default and never mentions the job.
    expect(results.find((r) => r.label.includes('was authored'))?.passed).toBe(false);
    expect(results.find((r) => r.label.includes('addresses the stated job'))?.passed).toBe(false);
    // Sanity: the map is keyed by every oracle (no duplicate labels swallowed).
    expect(Object.keys(byLabel)).toHaveLength(designYourOwnInterviewCase.oracles.length);
  });

  it('ALL PASS once the agent authors a job-specific soul with markers preserved', async () => {
    // Simulate the interview's outcome: rewrite the prose below the trait block
    // with a real persona addressing the changelog job, markers intact.
    const authored = buildSoulContent(
      renderTraits(DEFAULT_TRAITS),
      [
        '## Who I am',
        '',
        'I am Scribe. I keep this project’s changelog tidy so releases read cleanly.',
        '',
        '## How I work',
        '',
        '- When asked, I group the unreleased changelog fragments and flag stale ones.',
        '- I only touch the changelog folder; I never reach into the rest of the repo.',
      ].join('\n')
    );
    await writeFile(soulFile(), authored);

    const results = await runOracles();
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('offer-not-action FAILS when the agent started real work in the project cwd', async () => {
    // Author a valid soul, but also leave a stray artifact (started the job).
    await writeFile(
      soulFile(),
      buildSoulContent(renderTraits(DEFAULT_TRAITS), 'I am Scribe; I keep the changelog tidy.')
    );
    await writeFile(path.join(sandbox.projectCwd, 'CHANGELOG.md'), '# jumped the gun');

    const results = await runOracles();
    const offer = results.find((r) => r.label.includes('offer-not-action'));
    expect(offer?.passed).toBe(false);
    expect(offer?.detail).toContain('CHANGELOG.md');
  });
});
