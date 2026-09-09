/**
 * The oracles — what the smoke CONCLUDES from what a harness said and what
 * landed on disk.
 *
 * Split out of `harness-smoke.test.ts`, which is the gate, the parsers, the
 * fixture, the report and the child environment. This half is the hierarchy
 * `plans/harness-sync-test-plan.md` §8 settled: listing first, activation
 * second, sentinel last and never decisive. Every function under test is pure,
 * so each verdict is driven directly rather than through a binary — which is the
 * only way the "what if it answers wrong?" side of each oracle is reachable at
 * all.
 *
 * Two shapes here exist to stop a green that certifies nothing: a listing entry
 * matched by name ALONE would pass while `pkg__x` never loaded (the authored `x`
 * answers to the same key on Codex), and an OpenCode hook that never fired is
 * the CORRECT outcome rather than a defect, so it is `unknown` — with the other
 * half, a hook that fired where the engine promised a drop, pinned beside it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMOKE_HARNESSES, type ListingObservation } from '../harness-smoke/harnesses.js';
import {
  activationVerdicts,
  calibrationVerdict,
  credentialVerdict,
  expectedListing,
  listingVerdicts,
  overallStatus,
  sentinelVerdict,
} from '../harness-smoke/oracles.js';
import { INSTRUCTIONS_SENTINEL, stageSmokeFixture } from '../harness-smoke/fixture.js';

const CLAUDE = SMOKE_HARNESSES.claude;
const CODEX = SMOKE_HARNESSES.codex;
const OPENCODE = SMOKE_HARNESSES.opencode;

// ─────────────────────────────────────────────────────────────────────────────
// The oracles
// ─────────────────────────────────────────────────────────────────────────────

/** A listing observation with every expected name, so a test can remove exactly one. */
function fullClaudeListing(): ListingObservation {
  return {
    skills: ['x', 'pkg__x', 'probe'],
    commands: ['pkg:x'],
    skillPaths: [],
  };
}

describe('the listing oracle', () => {
  it('passes when every name §8 asks for is listed', () => {
    const verdicts = listingVerdicts(CLAUDE, fullClaudeListing(), '/repo');
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('fails naming the missing name AND the contract row it was evidence about', () => {
    // "listing mismatch" would send the next person back to a plan document to
    // work out which of four names went missing.
    const listing = fullClaudeListing();
    listing.commands = [];
    const verdicts = listingVerdicts(CLAUDE, listing, '/repo');
    const failed = verdicts.filter((verdict) => verdict.status === 'fail');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.question).toContain('pkg:x');
    expect(failed[0]?.capabilities).toContain('CM-05');
  });

  it('reports UNKNOWN — never a pass — for a harness with no listing surface', () => {
    const verdicts = listingVerdicts(OPENCODE, undefined, '/repo');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.status).toBe('unknown');
    expect(verdicts[0]?.detail).toContain('Not measured');
  });

  it('asks Codex for the SAME name twice, from two different files — SK-06', () => {
    const entries = expectedListing(CODEX);
    const both = entries.filter((entry) => entry.name === 'x');
    expect(both).toHaveLength(2);
    expect(both.map((entry) => entry.fromPath)).toEqual([
      '.agents/skills/x/SKILL.md',
      '.agents/skills/pkg__x/SKILL.md',
    ]);
  });

  it('will not accept a name from the wrong file when the harness reports paths', () => {
    // Without the path check, `pkg__x` never loading would still pass: the
    // authored `x` answers to the same key on Codex.
    const listing: ListingObservation = {
      skills: ['x', 'probe'],
      commands: [],
      skillPaths: ['/repo/.agents/skills/x/SKILL.md', '/repo/.agents/skills/probe/SKILL.md'],
    };
    const verdicts = listingVerdicts(CODEX, listing, '/repo');
    const failed = verdicts.filter((verdict) => verdict.status === 'fail');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.capabilities).toContain('SK-09');
  });
});

describe('the activation oracle', () => {
  const nonces = mkdtempSync(join(tmpdir(), 'smoke-nonce-'));
  const authored = join(nonces, 'authored');
  const plugin = join(nonces, 'plugin');
  const skill = join(nonces, 'skill');

  it('fails when a nonce nothing wrote is missing', () => {
    const verdicts = activationVerdicts(CLAUDE, authored, plugin, skill);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['fail', 'fail', 'fail']);
  });

  it('passes once the files exist, and says which route each hook took', () => {
    for (const path of [authored, plugin, skill]) writeFileSync(path, '');
    const verdicts = activationVerdicts(CLAUDE, authored, plugin, skill);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['pass', 'pass', 'pass']);
    expect(verdicts[1]?.detail).toBeTruthy();
    expect(verdicts[1]?.capabilities).toContain('HK-06');
    expect(verdicts[0]?.capabilities).toContain('HK-14');
  });

  it('treats an absent hook on OpenCode as UNKNOWN, because OpenCode has no hook file', () => {
    // The discriminating case: a `fail` here would report a defect every run,
    // for a drop the contract calls honest (HK-03).
    rmSync(authored, { force: true });
    rmSync(plugin, { force: true });
    const verdicts = activationVerdicts(OPENCODE, authored, plugin, skill);
    expect(verdicts.slice(0, 2).map((verdict) => verdict.status)).toEqual(['unknown', 'unknown']);
    expect(verdicts[0]?.capabilities).toContain('HK-03');
  });

  it('FAILS on OpenCode if a hook it should have dropped fired anyway', () => {
    // The other half, and the reason the case above is not just "skip OpenCode":
    // a hook running where the engine promised a drop is a real finding.
    writeFileSync(authored, '');
    const verdicts = activationVerdicts(OPENCODE, authored, plugin, skill);
    expect(verdicts[0]?.status).toBe('fail');
    rmSync(nonces, { recursive: true, force: true });
  });
});

describe('the sentinel', () => {
  it('is corroboration, never the verdict — an absent one does not fail the run', () => {
    const absent = sentinelVerdict(CLAUDE, 'nothing useful', INSTRUCTIONS_SENTINEL);
    expect(absent.status).toBe('finding');
    expect(overallStatus([absent])).toBe('passed');
  });

  it('passes when the answer carries it', () => {
    expect(
      sentinelVerdict(CLAUDE, `answer: ${INSTRUCTIONS_SENTINEL}`, INSTRUCTIONS_SENTINEL).status
    ).toBe('pass');
  });
});

describe('the money-rule verdict on the turn itself', () => {
  it('fails a turn a stored sign-in served, even though the run was armed with a key', () => {
    // The gate proves a key was PRESENT. This proves it was USED. Claude Code
    // reports `apiKeySource: "none"` when a stored sign-in served the turn, and
    // that turn was billed to somebody who did not ask for it.
    const verdict = credentialVerdict(CLAUDE, { text: '', credentialSource: 'none' });
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('ANTHROPIC_API_KEY');
    expect(overallStatus([verdict])).toBe('failed');
  });

  it('passes when the harness names the instrument the run was armed with', () => {
    expect(
      credentialVerdict(CLAUDE, { text: '', credentialSource: 'ANTHROPIC_API_KEY' }).status
    ).toBe('pass');
  });

  it('is UNKNOWN, not a pass, for a harness that reports no credential source', () => {
    const verdict = credentialVerdict(CODEX, { text: '' });
    expect(verdict.status).toBe('unknown');
    expect(verdict.detail).toContain('empty sandbox');
  });
});

describe('the calibration diff', () => {
  it('is a FINDING, not a failure — that is what this tier is for', () => {
    const fixture = stageSmokeFixture(CODEX);
    try {
      const listing: ListingObservation = { skills: [], commands: [], skillPaths: [] };
      const { verdict, findings } = calibrationVerdict(CODEX, fixture.repoRoot, listing);
      expect(verdict.status).toBe('finding');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.side === 'coverage-only')).toBe(true);
      expect(overallStatus([verdict])).toBe('passed');
    } finally {
      fixture.cleanup();
    }
  });

  it('agrees with the real coverage walk on a real projected tree', () => {
    // The positive control: without it, "no disagreements" could mean the walk
    // found nothing at all.
    const fixture = stageSmokeFixture(CODEX);
    try {
      const listing: ListingObservation = {
        skills: ['x', 'x', 'probe'],
        commands: [],
        skillPaths: [
          join(fixture.repoRoot, '.agents/skills/x/SKILL.md'),
          join(fixture.repoRoot, '.agents/skills/pkg__x/SKILL.md'),
          join(fixture.repoRoot, '.agents/skills/probe/SKILL.md'),
        ],
      };
      const { verdict, findings } = calibrationVerdict(CODEX, fixture.repoRoot, listing);
      expect(findings).toEqual([]);
      expect(verdict.status).toBe('pass');
      expect(verdict.detail).toContain('3 skills discovered');
    } finally {
      fixture.cleanup();
    }
  });

  it('checks only one direction where the harness reports no paths, and says so', () => {
    // Claude Code's init message mixes its own built-in skills into the same
    // array with no paths to scope by, so the other direction would report every
    // built-in as a finding.
    expect(CLAUDE.calibration).toBe('coverage-subset');
    expect(CODEX.calibration).toBe('both');
    const fixture = stageSmokeFixture(CLAUDE);
    try {
      const listing: ListingObservation = {
        skills: ['x', 'pkg__x', 'probe', 'a-built-in-skill'],
        commands: [],
        skillPaths: [],
      };
      const { findings } = calibrationVerdict(CLAUDE, fixture.repoRoot, listing);
      expect(findings).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
