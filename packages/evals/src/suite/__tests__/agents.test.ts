/**
 * Deterministic guard for the `design-your-own-interview` case — its SEED and
 * its ORACLES, without a model. The eval's real run needs a credentialed model
 * (the interview is model behavior); this test proves the plumbing around it:
 * the seed lays down a valid newborn scaffold, and each oracle has a genuine
 * pass AND fail (so a broken always-pass oracle is caught, per the harness's
 * own oracle-test discipline). The filesystem oracles are exercised by writing
 * the soul the agent would author; the two DETERMINISTIC transcript oracles are
 * exercised with fabricated turn frames — a structural check on `?` counts and a
 * fixed offer phrase, never a prose judgment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSoulContent } from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { EvalSandbox, OracleContext, OracleResult } from '../../types.js';
import { designYourOwnInterviewCase } from '../agents.js';

let sandbox: EvalSandbox;
let root: string;

/** Frames for one assistant turn: `turn_start` → one `text_delta` → `turn_end`. */
function assistantTurn(text: string): SseFrame[] {
  return [
    { event: 'turn_start', data: { type: 'turn_start' } },
    { event: 'text_delta', data: { type: 'text_delta', text } },
    { event: 'turn_end', data: { type: 'turn_end' } },
  ];
}

/**
 * A well-behaved interview transcript: two interview turns (one question each)
 * then a closing turn that offers a first action. Question count across the
 * interview turns = 2 (≤ budget); the final turn carries an offer signal.
 */
function goodInterviewFrames(): SseFrame[] {
  return [
    ...assistantTurn('Hi — what would you like me to take care of?'),
    ...assistantTurn('Got it. Should I only ever touch the changelog folder?'),
    ...assistantTurn(
      "I've written my soul. Want me to start by grouping the unreleased fragments?"
    ),
  ];
}

/** An OracleContext over the seeded sandbox with an optional transcript. */
function ctx(frames: SseFrame[] = []): OracleContext {
  return { sandbox, baseUrl: 'http://unused', sessionId: 's', frames };
}

/** Run every oracle on the case with the given transcript and return their results. */
function runOracles(frames: SseFrame[] = goodInterviewFrames()): Promise<OracleResult[]> {
  return Promise.all(designYourOwnInterviewCase.oracles.map((o) => o(ctx(frames))));
}

/** Run the case oracles over `frames` and return the one whose label contains `needle`. */
async function resultByLabel(needle: string, frames: SseFrame[]): Promise<OracleResult> {
  const results = await runOracles(frames);
  const match = results.find((r) => r.label.includes(needle));
  if (!match) throw new Error(`no oracle labelled with "${needle}"`);
  return match;
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
  it('is a credentialed, experimental, non-gating case (kept out of core)', () => {
    expect(designYourOwnInterviewCase.id).toBe('design-your-own-interview');
    expect(designYourOwnInterviewCase.runtimeTier).toBe('claude-code-cheap');
    // Experimental + quarantined, NOT core: the multi-turn credentialed drive
    // hits a claude-code session-remap timeout, so it cannot yet be a live gate
    // (the deterministic oracle tests below still gate). See agents.ts.
    expect(designYourOwnInterviewCase.tags).toContain('experimental');
    expect(designYourOwnInterviewCase.tags).not.toContain('core');
    expect(designYourOwnInterviewCase.quarantined).toBe(true);
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

describe('transcript oracles (deterministic — question budget + first-action offer)', () => {
  it('question-budget PASSES within budget and FAILS when the interview over-asks', async () => {
    const within = await resultByLabel('question budget', goodInterviewFrames());
    expect(within.passed).toBe(true);

    // Four questions in the single interview turn (the closing turn is excluded).
    const overAsking = [
      ...assistantTurn('What scope? Which folders? How often? Anything off-limits?'),
      ...assistantTurn('Done — shall I begin?'),
    ];
    const exceeded = await resultByLabel('question budget', overAsking);
    expect(exceeded.passed).toBe(false);
    expect(exceeded.detail).toContain('budget');
  });

  it('first-action PASSES when the closing turn offers and FAILS when it does not', async () => {
    const offered = await resultByLabel('first action', goodInterviewFrames());
    expect(offered.passed).toBe(true);

    const noOffer = [
      ...assistantTurn('Hi — what would you like me to handle?'),
      ...assistantTurn('My soul is written. It is complete.'),
    ];
    const missing = await resultByLabel('first action', noOffer);
    expect(missing.passed).toBe(false);
  });

  it('an empty transcript: budget passes trivially, but the missing offer FAILS honestly', async () => {
    const budget = await resultByLabel('question budget', []);
    expect(budget.passed).toBe(true); // no interview turns → nothing asked
    const offer = await resultByLabel('first action', []);
    expect(offer.passed).toBe(false); // no closing turn → no offer to find
  });

  it('the closing turn is excluded from the question count (offer-question does not over-count)', async () => {
    // Two interview questions + a closing turn that is ALSO phrased as a question.
    // Only the two interview questions count, so a budget of 3 still passes.
    const frames = [
      ...assistantTurn('What should I take care of?'),
      ...assistantTurn('Only the changelog folder?'),
      ...assistantTurn('Soul written. Want me to start with the unreleased fragments?'),
    ];
    const budget = await resultByLabel('question budget', frames);
    expect(budget.passed).toBe(true);
  });
});
