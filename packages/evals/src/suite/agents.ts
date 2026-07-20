/**
 * The agents suite — evals that guard the agent-creation experience. Ships the
 * Wave 3 `design-your-own-interview` case: a `claude-code-cheap` judgment eval
 * that proves a newborn "Design your own" agent, driven by the REAL interview
 * kickoff prompt (`@dorkos/shared/kickoff-prompts`, the same builder the client
 * POSTs), actually WRITES its own `SOUL.md` live in the conversation and keeps
 * the offer-not-action discipline.
 *
 * WHY A REAL TIER: the interview is model behavior — asking sharp questions and
 * authoring a file through the agent's own file tools — which `test-mode` cannot
 * produce. So this case runs on `claude-code-cheap`; without `ANTHROPIC_API_KEY`
 * the runner reports it as a runner `error` (never a false pass), exactly like
 * the other credentialed cases.
 *
 * WHAT IT MEASURES (on artifacts / filesystem, plus two DETERMINISTIC transcript
 * checks — never a prose judgment):
 * - the agent rewrote its seeded `SOUL.md` (the authored persona differs from
 *   the default template and is non-trivial),
 * - the trait markers survived (`<!-- TRAITS:START/END -->` intact, so the
 *   trait-slider regeneration the context-builder relies on still works),
 * - the authored persona addresses the stated job (the job's key noun appears
 *   in the soul the agent wrote),
 * - offer-not-action held: the agent touched ONLY its own `.dork/` files and
 *   started none of the real work in its project cwd,
 * - the interview stayed within `INTERVIEW_QUESTION_BUDGET` — a LITERAL `?` count
 *   across the interview turns (every assistant turn except the closing one),
 * - the closing turn PROPOSES A FIRST ACTION — the final assistant message
 *   contains a committed offer signal ("Want me to…?", "Shall I…", …). Both
 *   transcript oracles read the live turn stream structurally, so they are
 *   reproducible, not subjective.
 *
 * WHAT IT DOES NOT MEASURE (documented coverage gaps): the question budget is
 * ALSO bounded by CONSTRUCTION — the drive scripts a fixed, small number of user
 * turns, so an agent that never converges fails the artifact oracles regardless;
 * the transcript oracle now adds the literal count on top of that structural
 * proxy, and the prompt-copy wording ("≤N questions") stays guarded by the
 * `@dorkos/shared` test (`kickoff-prompts.test.ts`). The first-action oracle
 * checks that an offer is PRESENT, not whether it is the *smartest* first action.
 * Subjective interview quality (tone, whether the follow-ups were the *sharpest*
 * ones) is left to a future LLM-judge rubric — the harness's Phase-3 judge scorer
 * — not asserted here, because a loose prose match would be a weaker and flakier
 * signal than the concrete checks this case pins.
 *
 * KNOWN CREDENTIALED-RUN LIMITATION (verified 2026-07-20 against real
 * claude-code on host auth): the subscribe-first drive opens `/events` on the
 * session id it holds BEFORE the trigger POST, but claude-code re-mints its
 * internal session id on a resume, so an intermediate turn's frames can land on
 * the post-remap id and the pre-remap subscription times out — surfacing this
 * eval as a runner `error` (never a false pass). The interview's PRODUCT
 * behavior was confirmed end-to-end by hand (the newborn agent read then Edited
 * its own `.dork/SOUL.md` mid-conversation, markers intact, addressing the job,
 * and only OFFERED its first action) — every oracle here passed against that
 * real artifact. Making the multi-turn drive robust to the mid-conversation
 * remap is a general harness improvement (it affects any multi-turn credentialed
 * eval, not just this one) and is deliberately left to a focused follow-up.
 *
 * @module evals/suite/agents
 */
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import {
  defaultSoulTemplate,
  defaultNopeTemplate,
  extractCustomProse,
  TRAIT_SECTION_START,
  TRAIT_SECTION_END,
} from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { buildKickoffInstruction, INTERVIEW_QUESTION_BUDGET } from '@dorkos/shared/kickoff-prompts';
import path from 'node:path';
import type { EvalCase, EvalSandbox } from '../types.js';
import { fileMatches, dirContainsOnly } from '../oracles/filesystem.js';
import { assistantAsksAtMost, finalAssistantMessageMatches } from '../oracles/transcript.js';

/** The newborn agent's display name for the seeded scaffold + the interview. */
const AGENT_NAME = 'Scribe';

/** The job the scripted person hands the agent; its key noun anchors an oracle. */
const JOB_KEYWORD = 'changelog';

/** Resolve the seeded agent's `SOUL.md` inside the sandbox project cwd. */
const soulPath = (sandbox: EvalSandbox): string =>
  path.join(sandbox.projectCwd, '.dork', 'SOUL.md');

/**
 * The default persona prose a fresh agent is scaffolded with (below the trait
 * block). The interview must REPLACE this — an oracle asserts the authored prose
 * is no longer this default, proving the agent actually wrote its own soul.
 */
function seededDefaultProse(): string {
  const traitBlock = renderTraits(DEFAULT_TRAITS);
  return extractCustomProse(defaultSoulTemplate(AGENT_NAME, traitBlock));
}

/**
 * Seed a newborn "Design your own" agent into the sandbox: the same on-disk
 * scaffold `createAgentWorkspace` writes for a blank agent — a valid
 * `agent.json`, a default `SOUL.md` (trait block + generic prose), and a
 * `NOPE.md` — so the interview has a real soul to rewrite in place.
 *
 * @param sandbox - The fresh eval sandbox (its `projectCwd` becomes the agent dir).
 */
async function seedNewbornAgent(sandbox: EvalSandbox): Promise<void> {
  const traitBlock = renderTraits(DEFAULT_TRAITS);
  const manifest: AgentManifest = {
    id: '01JQXYZDESIGNYOUROWNSCRIBE',
    name: 'scribe',
    displayName: AGENT_NAME,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    traits: DEFAULT_TRAITS,
    conventions: { soul: true, nope: true, dorkosKnowledge: true },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-evals',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
  };
  await writeManifest(sandbox.projectCwd, manifest);
  await writeConventionFile(
    sandbox.projectCwd,
    'SOUL.md',
    defaultSoulTemplate(AGENT_NAME, traitBlock)
  );
  await writeConventionFile(sandbox.projectCwd, 'NOPE.md', defaultNopeTemplate());
}

/**
 * The scripted person's side of the interview. Turn 1 is the REAL interview
 * kickoff instruction (so the eval exercises the shipped prompt, not a copy);
 * the rest are the human's answers — a clear job on the first reply, then a
 * go-ahead. Only these turns are driven, so the agent must converge (ask its
 * questions, then write the soul) inside the ≤3-question budget the interview
 * prompt sets, or the artifact oracles fail.
 */
const INTERVIEW_TURNS: string[] = [
  buildKickoffInstruction('design-your-own', { displayName: AGENT_NAME }),
  `I want you to keep this project's ${JOB_KEYWORD} tidy: whenever I ask, group the unreleased ${JOB_KEYWORD} fragments and flag any that read as stale. Only ever touch the ${JOB_KEYWORD} folder — never anything else in the repo.`,
  'Yes, that captures it exactly — go ahead and write your soul, then tell me what you would do first.',
];

/**
 * Fixed, committed offer signals — natural ways a newborn agent proposes ONE
 * concrete first action and waits ("Want me to…?", "Shall I…", "I can start
 * by…", "just say the word"). A DETERMINISTIC phrase list (not a judgment): the
 * final-message oracle passes iff the closing turn contains one of these. Curly
 * apostrophes are normalized so "if you'd like" matches either quote form.
 */
const FIRST_ACTION_OFFER_SIGNALS: readonly string[] = [
  'would you like',
  'want me to',
  'shall i',
  'should i',
  'i can start',
  'i could start',
  'i can begin',
  'i could begin',
  'let me know',
  'just say',
  'give me the go',
  'go ahead',
  "if you'd like",
  'if you like',
  'if you want',
  'ready when you are',
  'start with',
  'first action',
];

/**
 * Whether an assistant message reads as a first-action OFFER: it contains at
 * least one committed offer signal. Deterministic and reproducible — the same
 * text always yields the same verdict.
 *
 * @param message - The final assistant turn's text.
 */
function proposesFirstAction(message: string): boolean {
  const normalized = message.toLowerCase().replace(/’/g, "'");
  return FIRST_ACTION_OFFER_SIGNALS.some((signal) => normalized.includes(signal));
}

/**
 * `design-your-own-interview` — the newborn agent writes its own soul. Seeds a
 * blank agent, drives the real interview prompt + two scripted human answers,
 * then asserts on the `SOUL.md` the agent authored, on the offer-not-action
 * discipline, and on two DETERMINISTIC transcript checks (question budget, a
 * first-action offer in the closing turn). Credentialed tier; a missing key
 * surfaces as a runner error.
 */
export const designYourOwnInterviewCase: EvalCase = {
  id: 'design-your-own-interview',
  title: 'Design your own — the newborn agent interviews, then writes its own SOUL.md',
  prompt: INTERVIEW_TURNS,
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  // `experimental`, NOT `core`, and quarantined: on the credentialed tier the
  // multi-turn drive can hit a claude-code session-remap timeout (see the module
  // doc's KNOWN CREDENTIALED-RUN LIMITATION), so it cannot yet be a reliable live
  // gate. Keeping it out of `core` + non-gating means a credentialed core run
  // stays green; the deterministic oracle unit tests still gate on every PR.
  // Promote to `core` (drop `quarantined`) once the remap-robust drive lands.
  tags: ['experimental'],
  quarantined: true,
  // A real multi-turn interview + a file write is more than a trivial turn; give
  // it headroom before the per-eval ceiling trips.
  perEvalCeilingUsd: 0.5,
  seed: seedNewbornAgent,
  oracles: [
    fileMatches(
      soulPath,
      (content) => content.includes(TRAIT_SECTION_START) && content.includes(TRAIT_SECTION_END),
      'SOUL.md keeps its trait markers intact'
    ),
    fileMatches(
      soulPath,
      (content) => {
        const prose = extractCustomProse(content);
        // Authored, not the scaffold: the prose changed from the default and is
        // a real persona, not an empty or one-word stub.
        return prose.length > 40 && prose.trim() !== seededDefaultProse().trim();
      },
      'SOUL.md persona prose was authored (differs from the default scaffold)'
    ),
    fileMatches(
      soulPath,
      (content) => new RegExp(JOB_KEYWORD, 'i').test(extractCustomProse(content)),
      `SOUL.md persona addresses the stated job (mentions "${JOB_KEYWORD}")`
    ),
    dirContainsOnly(
      (sandbox) => sandbox.projectCwd,
      ['.dork'],
      'offer-not-action: the agent touched only its own .dork/ files, started no real work'
    ),
    // Deterministic transcript coverage for two behavioral criteria that leave
    // no filesystem trace (see the module doc). Both read the live turn stream
    // structurally — a literal `?` count and a fixed-phrase offer signal — never
    // a prose judgment.
    assistantAsksAtMost(
      INTERVIEW_QUESTION_BUDGET,
      `interview stays within the ${INTERVIEW_QUESTION_BUDGET}-question budget`
    ),
    finalAssistantMessageMatches(
      proposesFirstAction,
      'the closing turn proposes a concrete first action (offer, not action)'
    ),
  ],
};
