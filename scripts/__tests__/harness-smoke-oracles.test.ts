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
import { calibrationVerdict } from '../harness-smoke/calibration.js';
import {
  activationVerdicts,
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

  it('counts within one list, so Claude Code’s two arrays are not read as two loads', () => {
    // Claude Code's session-init message carries a skill's name in `skills` AND
    // again in `slash_commands` — its commands and skills share one namespace.
    // Summing across the two reported every skill as "listed 2×": an artifact of
    // the message's shape rather than a harness loading anything twice, and it
    // would hide a real duplicate behind a number that is always two.
    const asRealClaudeReportsIt: ListingObservation = {
      skills: ['x', 'pkg__x', 'probe'],
      commands: ['x', 'pkg__x', 'probe', 'pkg:x'],
      skillPaths: [],
    };
    const verdicts = listingVerdicts(CLAUDE, asRealClaudeReportsIt, '/repo');
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    for (const verdict of verdicts) expect(verdict.detail).toContain('Listed 1×');
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

  it('distinguishes "no listing surface" from "the probe never answered"', () => {
    // Both are `unknown` and they mean opposite things: one is a documented gap,
    // the other is a broken probe. Reporting the second as the first hides a
    // dead turn behind a known limitation.
    const gap = listingVerdicts(CLAUDE, undefined, '/repo', 'no-surface');
    const broken = listingVerdicts(CLAUDE, undefined, '/repo', 'no-startup-record');
    expect(gap[0]?.detail).not.toMatch(/DID NOT RUN/);
    expect(broken[0]?.detail).toMatch(/DID NOT RUN/);
    expect(broken[0]?.detail).toMatch(/stderr/);
  });

  it('counts, so SK-12’s "loaded ONCE" is asked as a number', () => {
    // "Is it listed?" answers true for the right answer and the wrong one alike.
    // OpenCode reads both `.agents/skills` and `.claude/skills`, so the probe
    // skill is reachable twice through one target and SK-12 asks for one entry.
    const once: ListingObservation = { skills: ['x', 'probe'], commands: [], skillPaths: [] };
    const twice: ListingObservation = {
      skills: ['x', 'probe', 'probe'],
      commands: [],
      skillPaths: [],
    };
    const sk12 = (listing: ListingObservation) =>
      listingVerdicts(OPENCODE, listing, '/repo').find((v) => v.capabilities.includes('SK-12'));
    expect(sk12(once)?.status).toBe('pass');
    expect(sk12(twice)?.status).toBe('fail');
    expect(sk12(twice)?.detail).toContain('Listed 2×');
  });

  it('says SK-09 is NOT ANSWERABLE on OpenCode rather than dropping it', () => {
    // OpenCode keys by frontmatter name, so the `pkg__x` DIRECTORY answers to
    // `x` and is indistinguishable from the authored skill in a name-only
    // listing. A shorter expectation list would have read as coverage.
    const verdicts = listingVerdicts(
      OPENCODE,
      { skills: ['x', 'probe'], commands: [], skillPaths: [] },
      '/repo'
    );
    const sk09 = verdicts.find((v) => v.capabilities.includes('SK-09'));
    expect(sk09?.status).toBe('unknown');
    expect(sk09?.detail).toMatch(/NOT ANSWERABLE/);
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
    // The authored hook cites NO contract row: `.claude/settings.json` is the
    // person's own file and the engine writes nothing there, so it is a positive
    // control on the probe. HK-14 is about DorkOS READING `settings.local.json`
    // and `~/.claude/settings.json` as sources, which this does not test — and
    // stamping it here would report coverage for a row nothing exercised.
    expect(verdicts[0]?.capabilities).toEqual([]);
    expect(verdicts[0]?.cites).toMatch(/control/i);
  });

  it('reports a hook as NOT RUN when no session started, rather than as a failure', () => {
    // A hook fires when a session starts. A `--free` Codex run starts none — its
    // free probe is a listing command — so calling the unfired hook a FAILURE
    // would be a red about the run's mode dressed as a red about the projection.
    // Its own never-written paths: the shared ones above are mutated by the
    // cases around it, and a test that passes because a neighbour wrote a file
    // is a test measuring the wrong thing.
    const unwritten = join(nonces, 'never-written');
    const noSession = activationVerdicts(CODEX, unwritten, unwritten, unwritten, {
      turnRan: false,
      skillProbeRan: false,
    });
    expect(noSession.slice(0, 2).map((verdict) => verdict.status)).toEqual(['unknown', 'unknown']);
    expect(noSession[0]?.detail).toMatch(/NOT RUN/);
    // …and it must still FAIL when a session DID start and the hook did not fire.
    const ran = activationVerdicts(CODEX, unwritten, unwritten, unwritten);
    expect(ran.slice(0, 2).map((verdict) => verdict.status)).toEqual(['fail', 'fail']);
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

describe('what the skill-activation oracle is allowed to claim', () => {
  const nonces = mkdtempSync(join(tmpdir(), 'smoke-claim-'));
  const skill = join(nonces, 'skill');
  writeFileSync(skill, '');

  it('claims INJECTION only on a harness whose file reads can be denied', () => {
    // THE ONE THAT MATTERS. `--sandbox` is a WRITE policy on Codex — all three
    // modes permit reads — and OpenCode is given nothing at all, so on both the
    // model can simply open the `SKILL.md` the prompt just named. A nonce there
    // proves the instruction was REACHED, and stamping SK-08/SK-09 off it is an
    // assertion satisfied by the wrong subject.
    const claude = activationVerdicts(CLAUDE, skill, skill, skill).at(-1);
    expect(claude?.status).toBe('pass');
    expect(claude?.question).toMatch(/INJECT/);
    expect(claude?.capabilities).toEqual(['SK-08', 'SK-09']);

    for (const harness of [CODEX, OPENCODE]) {
      const verdict = activationVerdicts(harness, skill, skill, skill).at(-1);
      expect(verdict?.status, `${harness.id}`).toBe('pass');
      expect(verdict?.question, `${harness.id}`).not.toMatch(/INJECT/);
      expect(verdict?.capabilities, `${harness.id} must not stamp SK-08/SK-09`).toEqual([]);
      expect(verdict?.detail).toMatch(/corroborates rather than proves/);
    }
  });

  it('calls Claude Code’s denial PARTIAL and names what is still open', () => {
    // A deny list cannot enumerate every way a shell reads a file, and a report
    // that said "denied" would read as proof.
    const verdict = activationVerdicts(CLAUDE, skill, skill, skill).at(-1);
    expect(verdict?.detail).toMatch(/PARTIALLY denied/);
    expect(verdict?.detail).toContain('python3');
    expect(
      CLAUDE.deniesFileReads.kind === 'partial' && CLAUDE.deniesFileReads.remaining.length
    ).toBeGreaterThan(3);
  });

  it('says the precedence question is unverified rather than assuming an answer', () => {
    // `--permission-mode bypassPermissions` may or may not override
    // `--disallowedTools`; if it does, the denial buys nothing. Nobody has run a
    // turn to find out, so the cell says so.
    expect(CLAUDE.deniesFileReads.note).toMatch(/unverified/);
    expect(CLAUDE.deniesFileReads.note).toContain('bypassPermissions');
  });

  it('reports NOT RUN — never a pass — when no model turn happened', () => {
    const verdict = activationVerdicts(CLAUDE, skill, skill, skill, {
      skillProbeRan: false,
    }).at(-1);
    expect(verdict?.status).toBe('unknown');
    expect(verdict?.detail).toMatch(/NOT RUN/);
    expect(verdict?.capabilities).toEqual([]);
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
    const verdict = credentialVerdict(CLAUDE, {
      startupSeen: true,
      text: '',
      credentialSource: 'none',
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('ANTHROPIC_API_KEY');
    expect(overallStatus([verdict])).toBe('failed');
  });

  it('passes when the harness names the instrument the run was armed with', () => {
    expect(
      credentialVerdict(CLAUDE, {
        startupSeen: true,
        text: '',
        credentialSource: 'ANTHROPIC_API_KEY',
      }).status
    ).toBe('pass');
  });

  it('is UNKNOWN, not a pass, for a harness that reports no credential source', () => {
    const verdict = credentialVerdict(CODEX, { startupSeen: false, text: '' });
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
