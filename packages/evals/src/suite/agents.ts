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
 * WHAT IT MEASURES (all on artifacts / filesystem, never the assistant's prose):
 * - the agent rewrote its seeded `SOUL.md` (the authored persona differs from
 *   the default template and is non-trivial),
 * - the trait markers survived (`<!-- TRAITS:START/END -->` intact, so the
 *   trait-slider regeneration the context-builder relies on still works),
 * - the authored persona addresses the stated job (the job's key noun appears
 *   in the soul the agent wrote),
 * - offer-not-action held: the agent touched ONLY its own `.dork/` files and
 *   started none of the real work in its project cwd.
 *
 * WHAT IT DOES NOT MEASURE (documented coverage gaps): the exact question count
 * is bounded by CONSTRUCTION — the drive scripts a fixed, small number of user
 * turns, so an agent that ignores the ≤3-question `INTERVIEW_QUESTION_BUDGET`
 * never reaches a written soul within them and fails the artifact
 * oracles. That is a structural proxy for the budget, not a literal count; the
 * literal "≤N questions" wording is guarded deterministically by the prompt-copy
 * test in `@dorkos/shared` (`kickoff-prompts.test.ts`). Subjective interview
 * quality (tone, whether the follow-ups were the *sharpest* ones) is left to a
 * future LLM-judge rubric — the harness's Phase-3 judge scorer — not asserted
 * here, because a loose prose match would be a weaker and flakier signal than
 * the concrete artifact this case pins.
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
import { buildKickoffInstruction } from '@dorkos/shared/kickoff-prompts';
import path from 'node:path';
import type { EvalCase, EvalSandbox } from '../types.js';
import { fileMatches, dirContainsOnly } from '../oracles/filesystem.js';

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
 * `design-your-own-interview` — the newborn agent writes its own soul. Seeds a
 * blank agent, drives the real interview prompt + two scripted human answers,
 * then asserts on the `SOUL.md` the agent authored and on the offer-not-action
 * discipline. Credentialed tier; a missing key surfaces as a runner error.
 */
export const designYourOwnInterviewCase: EvalCase = {
  id: 'design-your-own-interview',
  title: 'Design your own — the newborn agent interviews, then writes its own SOUL.md',
  prompt: INTERVIEW_TURNS,
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['core'],
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
  ],
};
