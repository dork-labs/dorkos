/**
 * The verdicts — what the smoke concludes from what the harness said and what
 * landed on disk.
 *
 * Every function here is pure: the runner does the spawning and the file
 * probing, and hands the results in. That is what lets the whole oracle
 * hierarchy be exercised against a fake binary without a model, which is the
 * only way the runner's own logic ever gets tested (a runner whose logic is only
 * ever exercised by the thing it is testing is a runner nobody can trust).
 *
 * ## Four statuses, and why `finding` is not `fail`
 *
 * - `pass` / `fail` — the oracle ran and answered.
 * - `unknown` — the oracle could not run at all: no listing surface exists for
 *   this harness yet, or the harness genuinely has nowhere for the artifact to
 *   go (OpenCode has no hook file, so a hook that did not fire is the CORRECT
 *   outcome). Reported loudly, never counted as a pass:
 *   `meta/harness-sync-capabilities.md` calls an unverified row unverified, and
 *   so does this.
 * - `finding` — the run noticed something that does not fail it: the calibration
 *   diff disagreed, or the corroborating sentinel was absent. The calibration
 *   one is the POINT of the run (`plans/harness-sync-test-plan.md` §11 line 13:
 *   "not a CI red; a report"), so the headline counts findings and the report
 *   names every one.
 *
 * @module harness-smoke/oracles
 */
import { existsSync, realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { harnessCoverage } from '../../packages/harness/dist/vendor-facts/coverage.js';
import { AUTHORED_SKILL, INSTALLED_PACKAGE, PROBE_SKILL } from './fixture.js';
import type { ListingObservation, SmokeHarness, TurnObservation } from './harnesses.js';

/** What one oracle concluded. */
export interface Verdict {
  /** Short stable id, so a report reads the same way twice. */
  id: string;
  /** Contract rows this verdict is evidence about. */
  capabilities: string[];
  /** What was asked, in a person's words. */
  question: string;
  /** The answer. */
  status: 'pass' | 'fail' | 'unknown' | 'finding';
  /** Why — always concrete, always naming the subject. */
  detail: string;
}

/** One name a listing must carry, and how it is recognised. */
export interface ExpectedEntry {
  /** The identifier the harness itself would use. */
  name: string;
  /** When the harness reports paths, the repo-relative `SKILL.md` this entry must come from. */
  fromPath?: string;
  /** Which contract rows this entry is evidence about. */
  capabilities: string[];
  /** What it proves, in a person's words. */
  because: string;
}

/**
 * The names §8 says this harness's listing must carry, for the fixture
 * {@link ./fixture.js#stageSmokeFixture} stages.
 *
 * Written per harness rather than shared, because §8 asks each binary a
 * different question and a shared list would quietly assert Claude Code's
 * directory keying against a harness that keys by frontmatter name.
 *
 * @param harness - the harness being asked.
 * @returns every entry the listing must carry, with the row it is evidence about.
 */
export function expectedListing(harness: SmokeHarness): ExpectedEntry[] {
  if (harness.harnessId === 'claude-code') {
    // Claude Code keys a skill by its DIRECTORY, and merges commands into
    // skills, so all four names sit in one namespace — which is exactly what
    // CM-05 is about.
    return [
      {
        name: AUTHORED_SKILL,
        capabilities: ['SK-01'],
        because: 'the authored skill reached Claude Code through the `.claude/skills` symlink',
      },
      {
        name: `${INSTALLED_PACKAGE}__${AUTHORED_SKILL}`,
        capabilities: ['SK-02', 'SK-09'],
        because: 'the installed skill loaded under its namespaced directory name',
      },
      {
        name: PROBE_SKILL,
        capabilities: ['SK-01'],
        because: 'the probe skill is loadable at all, which the activation oracle then relies on',
      },
      {
        name: `${INSTALLED_PACKAGE}:${AUTHORED_SKILL}`,
        capabilities: ['CM-05'],
        because:
          'the generated command wrapper is listed BESIDE the same-leaf skills rather than ' +
          'shadowing or being shadowed by them',
      },
    ];
  }

  if (harness.harnessId === 'codex') {
    // Codex keys by FRONTMATTER name, so the authored skill and the installed
    // one both answer to `x` — SK-06's collision, asked rather than assumed.
    return [
      {
        name: AUTHORED_SKILL,
        fromPath: `.agents/skills/${AUTHORED_SKILL}/SKILL.md`,
        capabilities: ['SK-01', 'SK-08'],
        because: 'the authored skill is native to Codex where it sits',
      },
      {
        name: AUTHORED_SKILL,
        fromPath: `.agents/skills/${INSTALLED_PACKAGE}__${AUTHORED_SKILL}/SKILL.md`,
        capabilities: ['SK-06', 'SK-09'],
        because:
          'the `pkg__x` directory loads on Codex under its frontmatter name, and a duplicate ' +
          'frontmatter name appears twice rather than collapsing',
      },
      {
        name: PROBE_SKILL,
        fromPath: `.agents/skills/${PROBE_SKILL}/SKILL.md`,
        capabilities: ['SK-01'],
        because: 'the probe skill is loadable at all',
      },
    ];
  }

  // OpenCode reads BOTH `.claude/skills` and `.agents/skills`, so the installed
  // skill is reachable twice — SK-12 asked as "does it appear once?".
  return [
    {
      name: AUTHORED_SKILL,
      capabilities: ['SK-01'],
      because: 'the authored skill is native to OpenCode where it sits',
    },
    {
      name: PROBE_SKILL,
      capabilities: ['SK-01'],
      because: 'the probe skill is loadable at all',
    },
  ];
}

/**
 * Whether the listing carried everything §8 expects.
 *
 * A missing entry names itself and the row it was evidence about, because
 * "listing mismatch" sends the next person back to this file to work out which
 * of four names went missing.
 *
 * @param harness - the harness being asked.
 * @param observed - what its listing said, or `undefined` when it has no listing surface.
 * @param repoRoot - the fixture root, for scoping path-bearing entries.
 * @returns one verdict per expected entry, plus the surface's own verdict.
 */
export function listingVerdicts(
  harness: SmokeHarness,
  observed: ListingObservation | undefined,
  repoRoot: string
): Verdict[] {
  if (!observed) {
    return [
      {
        id: 'listing',
        capabilities: ['SK-09', 'SK-12'],
        question: `Does ${harness.label} enumerate what it loaded?`,
        status: 'unknown',
        detail: harness.listing.note,
      },
    ];
  }

  const available = [...observed.skills, ...observed.commands];
  return expectedListing(harness).map((entry, index) => {
    const matched = matchEntry(entry, observed, repoRoot);
    return {
      id: `listing-${index + 1}`,
      capabilities: entry.capabilities,
      question: `Does ${harness.label} list \`${entry.name}\`${entry.fromPath ? ` from \`${entry.fromPath}\`` : ''}?`,
      status: matched ? 'pass' : 'fail',
      detail: matched
        ? `Listed — ${entry.because}.`
        : `NOT listed. ${entry.because}. The listing carried: ${available.join(', ') || '(nothing)'}.`,
    };
  });
}

/** Whether one expected entry is in the observation, honouring its path when it has one. */
function matchEntry(entry: ExpectedEntry, observed: ListingObservation, repoRoot: string): boolean {
  if (entry.fromPath === undefined) {
    return observed.skills.includes(entry.name) || observed.commands.includes(entry.name);
  }
  for (const [index, name] of observed.skills.entries()) {
    if (name !== entry.name) continue;
    const path = observed.skillPaths[index];
    if (path !== undefined && sameFixturePath(path, repoRoot, entry.fromPath)) return true;
  }
  return false;
}

/**
 * Whether a path a harness reported is the fixture-relative path expected.
 *
 * Compared through `realpath` on both sides: macOS hands out `/var/folders/…`
 * and resolves it to `/private/var/…`, and a projected entry may be reached
 * through a symlink, so a string compare would report a disagreement that is not
 * one.
 */
function sameFixturePath(reported: string, repoRoot: string, expectedRelative: string): boolean {
  const resolve = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(reported) === resolve(`${repoRoot}/${expectedRelative}`);
}

/** What the two projected hooks are supposed to do on this harness, and why. */
interface HookExpectation {
  /** The nonce path the hook's command writes. */
  nonce: string;
  /** Contract rows this hook is evidence about. */
  capabilities: string[];
  /** How the hook reaches this harness, in a person's words. */
  route: string;
  /** When set, this harness is not expected to run the hook at all, and why. */
  notApplicable?: string;
}

/**
 * How each of the fixture's two hooks reaches this harness.
 *
 * Both are staged for every run; which of them is a PROJECTION differs per
 * harness, and the verdict says which is which rather than reporting "a hook
 * fired". Claude Code reads the authored one where it sits and gets the
 * installed one merged into `.claude/settings.local.json` under the
 * `_dorkosHarness` sentinel; Codex gets both folded into one generated
 * `.codex/hooks.json`; OpenCode has no hook file at all, so both are honest
 * drops and neither can fire.
 *
 * @param harness - the harness being asked.
 * @param authoredHookNonce - the nonce the `.claude/settings.json` hook writes.
 * @param pluginHookNonce - the nonce the installed package's hook writes.
 * @returns the two expectations, in report order.
 */
export function hookExpectations(
  harness: SmokeHarness,
  authoredHookNonce: string,
  pluginHookNonce: string
): HookExpectation[] {
  if (harness.harnessId === 'claude-code') {
    return [
      {
        nonce: authoredHookNonce,
        capabilities: ['HK-14'],
        route: 'read natively from `.claude/settings.json`, which the engine never writes',
      },
      {
        nonce: pluginHookNonce,
        capabilities: ['HK-06'],
        route:
          'PROJECTED — merged into `.claude/settings.local.json` under the `_dorkosHarness` sentinel',
      },
    ];
  }
  if (harness.harnessId === 'codex') {
    return [
      {
        nonce: authoredHookNonce,
        capabilities: ['HK-01', 'HK-10'],
        route:
          'PROJECTED — translated through the vendored event map into the generated ' +
          '`.codex/hooks.json`, in the `{ description, hooks }` shape Codex documents',
      },
      {
        nonce: pluginHookNonce,
        capabilities: ['HK-01', 'HK-05'],
        route: 'PROJECTED — the installed package’s hook, folded into the same generated file',
      },
    ];
  }
  return [
    {
      nonce: authoredHookNonce,
      capabilities: ['HK-03'],
      route: 'dropped',
      notApplicable:
        'OpenCode has no hook file at all — its plugin API is code-based TypeScript — so the ' +
        'engine drops both hooks with a reason and there is nothing here for a binary to run. ' +
        'An absent nonce is the CORRECT outcome, which is why this is reported rather than failed.',
    },
    {
      nonce: pluginHookNonce,
      capabilities: ['HK-03'],
      route: 'dropped',
      notApplicable: 'Same reason as above; the installed package’s hook is dropped too.',
    },
  ];
}

/**
 * The activation oracle: did the projected hooks fire, and did the projected
 * skill's instruction reach the model?
 *
 * The file on disk is the whole verdict. A model cannot fake a hook firing, and
 * the turn ran with the harness's file-read tools denied, so the only route from
 * `SKILL.md` to a `touch` is the harness's own injection.
 *
 * @param harness - the harness being asked.
 * @param authoredHookNonce - the nonce the `.claude/settings.json` hook writes.
 * @param pluginHookNonce - the nonce the installed package's hook writes.
 * @param skillNonce - absolute path the probe skill's body instructs a `touch` of.
 * @returns one verdict per hook, plus the skill-injection verdict.
 */
export function activationVerdicts(
  harness: SmokeHarness,
  authoredHookNonce: string,
  pluginHookNonce: string,
  skillNonce: string
): Verdict[] {
  const hooks = hookExpectations(harness, authoredHookNonce, pluginHookNonce).map(
    (expectation, index): Verdict => {
      const fired = existsSync(expectation.nonce);
      if (expectation.notApplicable !== undefined) {
        return {
          id: `activation-hook-${index + 1}`,
          capabilities: expectation.capabilities,
          question: `Does a hook ${harness.label} ${expectation.route}s run anyway?`,
          status: fired ? 'fail' : 'unknown',
          detail: fired
            ? `\`${expectation.nonce}\` EXISTS, and nothing should have written it. ` +
              expectation.notApplicable
            : expectation.notApplicable,
        };
      }
      return {
        id: `activation-hook-${index + 1}`,
        capabilities: expectation.capabilities,
        question: `Does the hook ${harness.label} gets — ${expectation.route} — actually fire?`,
        status: fired ? 'pass' : 'fail',
        detail: fired
          ? `\`${expectation.nonce}\` exists, so the hook ran.`
          : `\`${expectation.nonce}\` was never written. Either the file is not in a shape ` +
            `${harness.label} reads, or it read it and refused to run it.`,
      };
    }
  );

  const skillLoaded = existsSync(skillNonce);
  return [
    ...hooks,
    {
      id: 'activation-skill',
      capabilities: ['SK-08', 'SK-09'],
      question: `Did ${harness.label} INJECT the probe skill rather than let the model read it?`,
      status: skillLoaded ? 'pass' : 'fail',
      detail: skillLoaded
        ? `\`${skillNonce}\` exists, and file-read tools were denied for this turn, so the ` +
          `instruction can only have arrived through the harness's own skill injection.`
        : `\`${skillNonce}\` was never written, so nothing proves the skill was loaded.`,
    },
  ];
}

/**
 * The sentinel — corroboration, never the verdict.
 *
 * Demoted on purpose (§8): a token in an output proves a model saw some text. It
 * cannot distinguish a harness that INJECTED `AGENTS.md` from a model that
 * opened it. So a missing sentinel is a note on a passing run, and it is
 * deliberately not a `fail`.
 *
 * @param harness - the harness being asked.
 * @param text - everything the turn said.
 * @param sentinel - the token the instructions carry.
 * @returns one corroborating verdict.
 */
export function sentinelVerdict(harness: SmokeHarness, text: string, sentinel: string): Verdict {
  const present = text.includes(sentinel);
  return {
    id: 'sentinel',
    capabilities: ['IN-01'],
    question: `Did ${harness.label}'s answer reproduce the instructions sentinel?`,
    status: present ? 'pass' : 'finding',
    detail: present
      ? 'Present — corroborates the instructions projection; on its own it would prove only that ' +
        'a model saw some text.'
      : 'Absent. Corroboration only, so this does not fail the run: the model may simply not have ' +
        'been asked for it. Read it beside the listing verdicts, never instead of them.',
  };
}

/**
 * The money-rule verdict: was the turn served by the instrument this run named,
 * or by something nobody armed?
 *
 * This is the one assertion that makes "we never used an ambient sign-in" a
 * measured property rather than a promise. Claude Code reports `apiKeySource` on
 * its session-init message and the claude-code runtime's `check-dependency.ts`
 * records that it is "present exactly when a key is in play" — so anything other
 * than the named variable means the turn was billed to somebody who did not ask.
 *
 * @param harness - the harness being asked.
 * @param turn - what the turn reported.
 * @returns the credential verdict, or `unknown` for a harness that reports none.
 */
export function credentialVerdict(harness: SmokeHarness, turn: TurnObservation): Verdict {
  const question = `Was the turn served by ${harness.keyVar}, and not by a sign-in on this machine?`;
  if (turn.credentialSource === undefined) {
    return {
      id: 'credential',
      capabilities: [],
      question,
      status: 'unknown',
      detail:
        `${harness.label} does not report which credential served the turn, so this run's only ` +
        `defense is the gate: ${harness.keyVar} was read from the environment and its config home ` +
        `was pointed at an empty sandbox. Nothing read a stored sign-in.`,
    };
  }
  const ok = turn.credentialSource === harness.keyVar;
  return {
    id: 'credential',
    capabilities: [],
    question,
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? `${harness.label} reported \`${turn.credentialSource}\`, which is the instrument this run named.`
      : `${harness.label} reported \`${turn.credentialSource}\`, NOT \`${harness.keyVar}\`. The turn ` +
        `was billed to a credential nobody armed; that is the exact failure the money rule exists ` +
        `to prevent, so this run fails.`,
  };
}

/**
 * The ceiling verdict.
 *
 * A harness that enforces its own ceiling (Claude Code's `--max-budget-usd`) is
 * checked against what it reported. One that does not gets an honest sentence
 * instead of an implied dollar limit: the run's ceiling was one turn and a wall
 * clock.
 *
 * @param harness - the harness being asked.
 * @param turn - what the turn reported.
 * @param maxUsd - the ceiling this run was given.
 * @returns the ceiling verdict.
 */
export function ceilingVerdict(
  harness: SmokeHarness,
  turn: TurnObservation,
  maxUsd: number
): Verdict {
  const question = `Did the run stay under its \`--max-usd ${maxUsd}\` ceiling?`;
  if (turn.costUsd === undefined) {
    return {
      id: 'ceiling',
      capabilities: [],
      question,
      status: 'unknown',
      detail: harness.enforcesCeiling
        ? `${harness.label} takes a ceiling but reported no cost for this turn, so nothing can be ` +
          `compared against it.`
        : `${harness.label} reports no dollar cost and takes no ceiling flag, so the ceiling this ` +
          `run actually enforced was ONE turn and a wall clock — not ${maxUsd} USD. Said plainly ` +
          `rather than implied.`,
    };
  }
  const ok = turn.costUsd <= maxUsd;
  return {
    id: 'ceiling',
    capabilities: [],
    question,
    status: ok ? 'pass' : 'fail',
    detail: `${turn.costUsd.toFixed(4)} USD against a ${maxUsd} USD ceiling.${
      ok ? '' : ' Over. Something looped; read the transcript before running it again.'
    }`,
  };
}

/** One disagreement between the engine's coverage walk and the binary's own listing. */
export interface CalibrationFinding {
  /** Which side claimed it. */
  side: 'coverage-only' | 'listing-only';
  /** The skill key in dispute. */
  key: string;
  /** Where it was seen. */
  where: string;
}

/**
 * The calibration diff — `harnessCoverage()` against the binary's own listing,
 * on the same tree.
 *
 * This is the half of the H tier that pays off every time it runs, whatever the
 * listing says: the vendor-facts table is compiled from documentation, and this
 * is the only thing that ever compares it to a binary.
 *
 * The direction is per harness, and honestly so. Codex reports an absolute path
 * beside every entry, so the listing can be scoped to the fixture and BOTH
 * directions checked. Claude Code reports names only and mixes its own built-in
 * skills into the same array, so only "everything the walk discovered is listed"
 * is checkable — the other direction would report every built-in as a finding.
 *
 * @param harness - the harness being asked.
 * @param repoRoot - the fixture root.
 * @param observed - the listing, or `undefined` when the harness has no surface.
 * @returns the verdict and every disagreement behind it.
 */
export function calibrationVerdict(
  harness: SmokeHarness,
  repoRoot: string,
  observed: ListingObservation | undefined
): { verdict: Verdict; findings: CalibrationFinding[] } {
  const question = `Does \`harnessCoverage('${harness.harnessId}')\` agree with what ${harness.label} listed?`;
  if (!observed) {
    return {
      verdict: {
        id: 'calibration',
        capabilities: ['SK-13', 'SK-14'],
        question,
        status: 'unknown',
        detail: `No listing surface to compare against. ${harness.listing.note}`,
      },
      findings: [],
    };
  }

  const walk = harnessCoverage(harness.harnessId, repoRoot);
  const listedNames = new Set(observed.skills);
  const findings: CalibrationFinding[] = [];

  for (const found of walk.discovered) {
    if (!listedNames.has(found.key)) {
      findings.push({
        side: 'coverage-only',
        key: found.key,
        where: relative(repoRoot, found.skillMd),
      });
    }
  }

  if (harness.calibration === 'both') {
    const walkKeys = new Set(walk.discovered.map((found) => found.key));
    for (const [index, name] of observed.skills.entries()) {
      const path = observed.skillPaths[index];
      // Only entries the fixture owns can disagree with a walk of the fixture.
      if (path === undefined || !insideFixture(path, repoRoot)) continue;
      if (!walkKeys.has(name)) {
        findings.push({ side: 'listing-only', key: name, where: relative(repoRoot, path) });
      }
    }
  }

  return {
    verdict: {
      id: 'calibration',
      capabilities: ['SK-13', 'SK-14'],
      question,
      status: findings.length === 0 ? 'pass' : 'finding',
      detail:
        findings.length === 0
          ? `${walk.discovered.length} skills discovered by the walk, all of them listed` +
            `${harness.calibration === 'both' ? ', and every fixture entry the listing carried was discovered' : ''}.` +
            `${walk.uncertain.length > 0 ? ` The walk also reported ${walk.uncertain.length} undecidable, which is data for the facts table, not a failure.` : ''}`
          : `${findings.length} disagreement(s) between the compiled vendor facts and the binary. ` +
            `That is the finding this tier exists to produce; it does not fail the run.`,
    },
    findings,
  };
}

/** Whether a path a harness reported lives inside the fixture. */
function insideFixture(path: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The run's overall answer.
 *
 * `finding` and `unknown` never fail: a calibration disagreement is the output of
 * the tier and an absent oracle is a documented gap. Only a `fail` — a name the
 * harness did not list, a nonce nothing wrote, a credential nobody armed, a
 * ceiling breached — is a failure.
 *
 * @param verdicts - every verdict the run produced.
 * @returns the process-level outcome.
 */
export function overallStatus(verdicts: readonly Verdict[]): 'passed' | 'failed' {
  return verdicts.some((verdict) => verdict.status === 'fail') ? 'failed' : 'passed';
}
