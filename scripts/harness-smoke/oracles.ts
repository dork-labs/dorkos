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
import { AUTHORED_SKILL, INSTALLED_PACKAGE, PROBE_SKILL } from './fixture.js';
import type { ListingObservation, SmokeHarness, TurnObservation } from './harnesses.js';

/**
 * What the two spend-gate verdicts cite instead of a contract row.
 *
 * They are properties of THIS RUNNER, not capabilities of the projection engine,
 * and `meta/harness-sync-capabilities.md` is a list of the latter. Adding a
 * `MONEY-01` row there would put a non-capability into the one document whose
 * value is that every row is one — and the census that parses it would have to
 * learn about the exception. So they name their sources directly instead.
 */
const MONEY_RULE_CITE = 'AGENTS.md’s four-money-paths table; `plans/harness-sync-test-plan.md` §8';

/** What one oracle concluded. */
export interface Verdict {
  /** Short stable id, so a report reads the same way twice. */
  id: string;
  /**
   * Contract rows this verdict is evidence about.
   *
   * Empty is a real answer, not an oversight: two verdicts here are about the
   * RUNNER rather than about the projection engine, and one is a positive
   * control. Those carry {@link Verdict.cites} instead.
   */
  capabilities: string[];
  /**
   * What a verdict with no contract row is evidence about, in words.
   *
   * `meta/harness-sync-capabilities.md`'s rows are capabilities of the
   * projection engine. The credential and ceiling verdicts are properties of
   * THIS RUNNER's spend gate, and the authored-hook verdict is a positive
   * control on the probe itself — inventing rows for them would put three
   * non-capabilities into a document whose whole value is that every row is one,
   * and the census that parses it would then have to know about them. So they
   * cite AGENTS.md's money table and `plans/harness-sync-test-plan.md` §8
   * directly.
   */
  cites?: string;
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
  /**
   * How many times the name must appear, when the count is the point.
   *
   * SK-12 is a question about a NUMBER: an installed skill linked into both
   * `.claude/skills` and `.agents/skills` is reachable twice by every harness
   * that reads both roots, and the row asks whether it is loaded once. "Is it
   * listed?" cannot answer that — the answer is `1`, and `2` is the finding.
   * Omitted where presence is all the row asks for.
   */
  occurrences?: number;
  /**
   * When set, this row cannot be answered from THIS harness's listing at all,
   * and this says why.
   *
   * The verdict becomes `unknown` and nothing is matched. It exists so a row §8
   * promises evidence for is still NAMED in the report when the evidence turns
   * out to be unreachable — the alternative is a silently shorter expectation
   * list, which reads as coverage.
   */
  unanswerable?: string;
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
          'the `pkg__x` directory loads on Codex under its frontmatter name — and together with ' +
          'the entry above it, two skills whose frontmatter agrees both appear rather than one ' +
          'collapsing into the other (SK-06)',
      },
      {
        name: PROBE_SKILL,
        fromPath: `.agents/skills/${PROBE_SKILL}/SKILL.md`,
        capabilities: ['SK-01'],
        because: 'the probe skill is loadable at all',
      },
    ];
  }

  // OpenCode reads BOTH `.claude/skills` and `.agents/skills`, so a projected
  // skill is reachable twice — SK-12 asked as "does it appear once?". The
  // SUBJECT matters: `probe` is the only skill in the fixture whose frontmatter
  // name is unique, so it is the one whose count isolates dedupe-by-target from
  // the name collision SK-06 is about.
  return [
    {
      name: AUTHORED_SKILL,
      capabilities: ['SK-01'],
      because: 'the authored skill is native to OpenCode where it sits',
    },
    {
      name: PROBE_SKILL,
      occurrences: 1,
      capabilities: ['SK-01', 'SK-12'],
      because:
        'one target — `.agents/skills/probe` — is reachable through two of OpenCode’s own read ' +
        'paths, directly and through the `.claude/skills/probe` link the engine wrote, and SK-12 ' +
        'asks for exactly one entry. Two is the finding',
    },
    {
      name: `${INSTALLED_PACKAGE}__${AUTHORED_SKILL}`,
      capabilities: ['SK-09'],
      because: 'the `pkg__x` directory shape is loadable by a harness that reads the directory',
      unanswerable:
        'OpenCode keys a skill by its frontmatter `name`, and the installed skill’s frontmatter ' +
        'says `x` — so the `pkg__x` DIRECTORY answers to the same key as the authored skill and ' +
        'is indistinguishable from it in a name-only listing. SK-09 needs a listing that carries ' +
        'FILE PATHS (Codex has one; OpenCode has no listing surface here at all yet), or a fixture ' +
        'whose package skill declares a different frontmatter name — which would then stop asking ' +
        'SK-09’s actual question, since the shape under test is the directory.',
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
  repoRoot: string,
  absence: ListingAbsence = 'no-surface'
): Verdict[] {
  if (!observed) {
    return [
      {
        id: 'listing',
        capabilities: ['SK-09', 'SK-12'],
        question: `Does ${harness.label} enumerate what it loaded?`,
        status: 'unknown',
        detail:
          absence === 'no-surface'
            ? harness.listing.note
            : 'The probe produced no startup record at all, so the listing oracle DID NOT RUN. ' +
              'That is a broken probe, not a documented gap — read the turn’s stderr before ' +
              `reading anything else in this report. ${harness.listing.note}`,
      },
    ];
  }

  const available = [...observed.skills, ...observed.commands];
  return expectedListing(harness).map((entry, index): Verdict => {
    const id = `listing-${index + 1}`;
    const question = `Does ${harness.label} list \`${entry.name}\`${
      entry.fromPath ? ` from \`${entry.fromPath}\`` : ''
    }${entry.occurrences === undefined ? '' : ` exactly ${entry.occurrences}×`}?`;
    if (entry.unanswerable !== undefined) {
      return {
        id,
        capabilities: entry.capabilities,
        question,
        status: 'unknown',
        detail: `NOT ANSWERABLE from this listing. ${entry.unanswerable}`,
      };
    }
    const count = countEntry(entry, observed, repoRoot);
    const wanted = entry.occurrences;
    const ok = wanted === undefined ? count > 0 : count === wanted;
    return {
      id,
      capabilities: entry.capabilities,
      question,
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `Listed ${count}× — ${entry.because}.`
        : `Listed ${count}× where ${wanted === undefined ? '1 or more' : String(wanted)} was ` +
          `expected. ${entry.because}. The listing carried: ${available.join(', ') || '(nothing)'}.`,
    };
  });
}

/** Why a listing is missing — a documented gap, or a probe that never answered. */
export type ListingAbsence = 'no-surface' | 'no-startup-record';

/**
 * How many times an expected entry appears, honouring its path when it has one.
 *
 * A COUNT rather than a boolean because SK-12 is a question about a NUMBER: one
 * target reachable through two read paths must produce one entry, and "is it
 * listed?" answers `true` for the right answer and the wrong one alike.
 */
function countEntry(entry: ExpectedEntry, observed: ListingObservation, repoRoot: string): number {
  if (entry.fromPath === undefined) {
    // Counted WITHIN one list, never across both. Claude Code's session-init
    // message carries a skill's name in `skills` AND again in `slash_commands`
    // (its commands and skills share one namespace), so a sum would report every
    // skill as "listed 2×" — an artifact of the message's shape, not a harness
    // loading anything twice, and it would hide a real duplicate behind a number
    // that is always two.
    const inSkills = observed.skills.filter((name) => name === entry.name).length;
    if (inSkills > 0) return inSkills;
    return observed.commands.filter((name) => name === entry.name).length;
  }
  let found = 0;
  for (const [index, name] of observed.skills.entries()) {
    if (name !== entry.name) continue;
    const path = observed.skillPaths[index];
    if (path !== undefined && sameFixturePath(path, repoRoot, entry.fromPath)) found += 1;
  }
  return found;
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
  /** Contract rows this hook is evidence about. Empty for a positive control. */
  capabilities: string[];
  /** What a control cites instead of a contract row. */
  cites?: string;
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
        // No contract row: `.claude/settings.json` is the person's own file and
        // the engine writes nothing there, so this is a POSITIVE CONTROL on the
        // probe — if it does not fire, hooks are off for reasons that have
        // nothing to do with a projection, and every other hook verdict below is
        // meaningless. HK-14 is about DorkOS READING `settings.local.json` and
        // `~/.claude/settings.json` as sources, which this does not test.
        capabilities: [],
        cites:
          'positive control on the probe — no contract row; see `plans/harness-sync-test-plan.md` §8',
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
 * @param opts - whether a session started at all, and whether a model turn did.
 * @returns one verdict per hook, plus the skill-injection verdict.
 */
export function activationVerdicts(
  harness: SmokeHarness,
  authoredHookNonce: string,
  pluginHookNonce: string,
  skillNonce: string,
  opts: { turnRan?: boolean; skillProbeRan: boolean } = { skillProbeRan: true }
): Verdict[] {
  const turnRan = opts.turnRan ?? true;
  const hooks = hookExpectations(harness, authoredHookNonce, pluginHookNonce).map(
    (expectation, index): Verdict => {
      const fired = existsSync(expectation.nonce);
      // No turn, no session, no hooks. Reporting an unfired hook as a FAILURE
      // when nothing ever started a session is a red about the run's mode
      // dressed as a red about the projection.
      if (!turnRan) {
        return {
          id: `activation-hook-${index + 1}`,
          capabilities: [],
          cites: 'needs a session; this run started none',
          question: `Does the hook ${harness.label} gets — ${expectation.route} — actually fire?`,
          status: 'unknown',
          detail:
            'NOT RUN. A hook fires when a session starts, and this run started none — ' +
            `${harness.label} has no free turn (${harness.free.note}). Run it with an ` +
            `instrument to answer it.`,
        };
      }
      if (expectation.notApplicable !== undefined) {
        return {
          id: `activation-hook-${index + 1}`,
          capabilities: expectation.capabilities,
          ...(expectation.cites === undefined ? {} : { cites: expectation.cites }),
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
        ...(expectation.cites === undefined ? {} : { cites: expectation.cites }),
        question: `Does the hook ${harness.label} gets — ${expectation.route} — actually fire?`,
        status: fired ? 'pass' : 'fail',
        detail: fired
          ? `\`${expectation.nonce}\` exists, so the hook ran.`
          : `\`${expectation.nonce}\` was never written. Either the file is not in a shape ` +
            `${harness.label} reads, or it read it and refused to run it.`,
      };
    }
  );

  return [...hooks, skillActivationVerdict(harness, skillNonce, opts.skillProbeRan)];
}

/**
 * The skill half of the activation oracle — and the one place the runner has to
 * be careful not to claim more than it measured.
 *
 * The oracle's strong form is "a skill that LOADED is the one whose instruction
 * the harness INJECTED, proved by denying the harness's file-read tools". That
 * form is only available where the binary HAS a per-tool deny, and only one of
 * the three does. Where it does not, the prompt names the skill and the model
 * can simply open `SKILL.md` — so the nonce proves the instruction was reached,
 * which is corroboration, not proof, and SK-08/SK-09 are dropped from the
 * citations rather than stamped off an oracle that cannot discriminate.
 *
 * @param harness - the harness being asked.
 * @param skillNonce - the path the probe skill's body instructs a `touch` of.
 * @param probeRan - false in `--free` mode, where no model turn happens at all.
 * @returns the skill-activation verdict.
 */
function skillActivationVerdict(
  harness: SmokeHarness,
  skillNonce: string,
  probeRan: boolean
): Verdict {
  const denial = harness.deniesFileReads;
  const proves = denial.kind === 'partial';
  const question = proves
    ? `Did ${harness.label} INJECT the probe skill rather than let the model read it?`
    : `Did the probe skill's instruction reach the model under ${harness.label}?`;
  // The citations follow what the oracle can DISCRIMINATE, not what the fixture
  // stages: SK-08 (the frontmatter dialect a harness must load) and SK-09 (the
  // `pkg__x` shape being loadable) are claims about the HARNESS loading a skill,
  // and a nonce a model could have produced by `cat`-ing the file is not evidence
  // for either.
  const capabilities = proves ? ['SK-08', 'SK-09'] : [];

  if (!probeRan) {
    return {
      id: 'activation-skill',
      capabilities: [],
      cites: 'needs a model turn; `--free` reaches no model',
      question,
      status: 'unknown',
      detail:
        'NOT RUN. This is the one oracle that needs a model to answer, and a `--free` run reaches ' +
        `none. Run it with an instrument to answer it: DORKOS_HARNESS_SMOKE=1 ${harness.keyVar}=<key>.`,
    };
  }

  const loaded = existsSync(skillNonce);
  if (!loaded) {
    return {
      id: 'activation-skill',
      capabilities,
      ...(proves ? {} : { cites: 'corroboration only — see the detail' }),
      question,
      status: 'fail',
      detail: `\`${skillNonce}\` was never written, so nothing suggests the skill was loaded.`,
    };
  }

  return {
    id: 'activation-skill',
    capabilities,
    ...(proves ? {} : { cites: 'corroboration only — see the detail' }),
    question,
    status: 'pass',
    detail: proves
      ? `\`${skillNonce}\` exists, and the file-read routes worth naming were PARTIALLY denied ` +
        `(${denial.flags}), so the instruction most likely arrived through the harness's own skill ` +
        `injection. Partially, not wholly: ${denial.remaining.join('; ')} are still open. ` +
        `${denial.note}`
      : `\`${skillNonce}\` exists, so the instruction REACHED the model — but reads were NOT ` +
        `denied on this harness, so this corroborates rather than proves. ${denial.note} The ` +
        `prompt names the skill, so a model could have opened \`SKILL.md\` itself and produced ` +
        `the same file. SK-08 and SK-09 are deliberately NOT cited here.`,
  };
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
 * @param turnRan - false when no turn happened at all, which is not an absence.
 * @returns one corroborating verdict.
 */
export function sentinelVerdict(
  harness: SmokeHarness,
  text: string,
  sentinel: string,
  turnRan = true
): Verdict {
  if (!turnRan) {
    return {
      id: 'sentinel',
      capabilities: [],
      cites: 'needs a model to answer; none did',
      question: `Did ${harness.label}'s answer reproduce the instructions sentinel?`,
      status: 'unknown',
      detail:
        'NOT RUN. There was no answer to look in. A free Claude Code run starts a session and ' +
        'prints its listing, and then never reaches a model — so the corroborating half has ' +
        'nothing to corroborate with.',
    };
  }
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
 * @param free - true for a `--free` run, where the variable holds a placeholder.
 * @returns the credential verdict, or `unknown` for a harness that reports none.
 */
export function credentialVerdict(
  harness: SmokeHarness,
  turn: TurnObservation,
  free = false
): Verdict {
  const question = free
    ? `Did ${harness.label} read ${harness.keyVar} rather than falling back to a stored sign-in?`
    : `Was the turn served by ${harness.keyVar}, and not by a sign-in on this machine?`;
  if (turn.credentialSource === undefined) {
    return {
      id: 'credential',
      capabilities: [],
      cites: MONEY_RULE_CITE,
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
    cites: MONEY_RULE_CITE,
    question,
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? free
        ? `${harness.label} reported \`${turn.credentialSource}\`. In a free run that variable holds ` +
          `a placeholder, not a key — so what this proves is the thing worth proving: with \`HOME\` ` +
          `and the config home pointed at an empty sandbox, the binary read the environment ` +
          `variable and did NOT fall back to a stored sign-in.`
        : `${harness.label} reported \`${turn.credentialSource}\`, which is the instrument this run named.`
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
      cites: MONEY_RULE_CITE,
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
    cites: MONEY_RULE_CITE,
    question,
    status: ok ? 'pass' : 'fail',
    detail: `${turn.costUsd.toFixed(4)} USD against a ${maxUsd} USD ceiling.${
      ok ? '' : ' Over. Something looped; read the transcript before running it again.'
    }`,
  };
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
