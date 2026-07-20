/**
 * Kickoff prompts — the synthetic first-turn instruction a freshly created
 * agent receives so it speaks first (M4, "it's alive"). Keyed by creation
 * origin so each way an agent can be born supplies its own opening.
 *
 * Lives in `@dorkos/shared` (next to the {@link wrapKickoff} envelope seam in
 * `./kickoff.js`) so it is one source of truth: the React client builds the
 * kickoff message and POSTs it, while the `@dorkos/evals` harness imports the
 * SAME builders to drive — and guard — the interview's produced behavior. The
 * client still owns WHICH origin a creation is; this module owns WHAT each
 * origin says.
 *
 * Two origins ship today:
 * - `template` — the agent arrived with a persona/soul (a gallery pick, a
 *   Shape's offered agent, a marketplace agent). It introduces itself from its
 *   SOUL.md and OFFERS a first action — it does not start working unprompted.
 * - `design-your-own` — a blank "Design your own" agent with no persona yet. It
 *   runs the interview: greet, hold a SHORT (≤3-question) interview, WRITE its
 *   own SOUL.md live in the conversation, then confirm and offer a first action.
 *
 * A new way to be born plugs in by adding an origin to {@link KickoffOrigin} and
 * a builder to {@link KICKOFF_BUILDERS} — nothing else changes.
 *
 * @module shared/kickoff-prompts
 */
import { wrapKickoff } from './kickoff.js';
import { CONVENTION_FILES, TRAIT_SECTION_START, TRAIT_SECTION_END } from './convention-files.js';

/** Which opening a newborn agent gets, keyed by how it was created. */
export type KickoffOrigin = 'template' | 'design-your-own';

/** What a builder needs to shape the opening for this specific agent. */
export interface KickoffContext {
  /** The agent's human name, for a personal greeting. */
  displayName: string;
  /** Declared capability namespaces, if any — seeds a concrete first-action offer. */
  capabilities?: string[];
}

/** Builds the plain (unfenced) kickoff instruction for one origin. */
type KickoffBuilder = (ctx: KickoffContext) => string;

/** Longest capability string interpolated into the prompt; the rest is cut. */
const CAPABILITY_MAX_CHARS = 64;

/** Most capabilities interpolated into the prompt; the rest are dropped. */
const CAPABILITY_MAX_COUNT = 16;

/**
 * The hard upper bound on questions the design-your-own interview may ask, as a
 * number — a single knob the prompt copy and the eval that guards it both read,
 * so the budget can never drift between the instruction and its test.
 */
export const INTERVIEW_QUESTION_BUDGET = 3;

/**
 * Sanitize third-party capability strings before they enter a prompt: collapse
 * newlines/control characters to spaces (a capability must never smuggle extra
 * prompt lines), squeeze whitespace, and cap the length. A template author's
 * manifest is not a trusted prompt surface.
 *
 * @param capabilities - Raw capability namespaces from the agent manifest.
 * @returns Cleaned, bounded capability labels (empties dropped).
 */
function sanitizeCapabilities(capabilities: string[]): string[] {
  return capabilities
    .map((cap) =>
      cap
        // eslint-disable-next-line no-control-regex -- stripping control chars is the point
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CAPABILITY_MAX_CHARS)
    )
    .filter((cap) => cap.length > 0)
    .slice(0, CAPABILITY_MAX_COUNT);
}

/**
 * A persona-bearing agent's opening: introduce yourself from SOUL.md, state the
 * job plainly, then OFFER a first action and wait — never act unprompted.
 */
function buildTemplateKickoff(ctx: KickoffContext): string {
  const caps = sanitizeCapabilities(ctx.capabilities ?? []);
  const abilities =
    caps.length > 0
      ? `\n\nYour declared abilities include: ${caps.join(', ')}. Draw your first-action offer from these when it fits.`
      : '';
  return [
    'You have just been created. This is your first moment awake — greet the person who made you.',
    '',
    `Read your ${CONVENTION_FILES.soul} to recall who you are, then, in 2 to 4 short sentences:`,
    '- Introduce yourself in your own voice, drawn from that persona.',
    '- State plainly what your job is.',
    '- Propose one concrete first action you could take — as an offer, and wait for their go-ahead.',
    '',
    `Do NOT start any work yet — do not act on the project or change any files. (Reading your own ${CONVENTION_FILES.soul} so you can introduce yourself is fine; anything beyond that waits for their go-ahead.) Just make the offer and let them decide. Speak warmly and directly to the person.` +
      abilities,
  ].join('\n');
}

/**
 * A blank agent's opening: the design-your-own INTERVIEW. Greet, hold a SHORT
 * interview (≤{@link INTERVIEW_QUESTION_BUDGET} questions, a hard budget), then
 * WRITE its own SOUL.md live in the conversation — persona prose below the trait
 * block, trait markers preserved — and finally confirm and OFFER a first action.
 * The magic is the person watching the soul get written; the discipline is that
 * the agent shows intent before writing and never starts the real job unprompted.
 */
function buildDesignYourOwnKickoff(ctx: KickoffContext): string {
  const named = ctx.displayName ? ` and named ${ctx.displayName}` : '';
  return [
    `You have just been created${named}, and you do not have a job yet — the person who made you will define it with you, right now, in this conversation. This is your first moment awake, and by the end of it you will have written your own ${CONVENTION_FILES.soul}.`,
    '',
    'Run a short interview to discover who you should be, then capture it:',
    '',
    '1. Say a brief, warm hello (1 to 2 sentences) and ask them what they would like you to take care of. Do not assume a role yet.',
    '',
    `2. Hold a SHORT interview. Ask AT MOST ${INTERVIEW_QUESTION_BUDGET} questions in total across this whole conversation — this is a hard limit. Only ask what you genuinely need to write a good soul (typically the scope of the work, how often you should do it, and anything you must never touch). If their first answer already tells you enough, ask fewer. For a one-word or vague answer, ask a single clarifying question and then proceed with a reasonable role rather than interrogating them. If they say something like "just figure it out," do not push — propose a sensible role from what you have and move on. Never trap them in endless back-and-forth: once you have asked ${INTERVIEW_QUESTION_BUDGET} questions, stop asking and write your best soul from what you learned.`,
    '',
    '3. Before you write, tell them in one line what you understood and that you are about to capture it as your soul — so they see it coming. Then write it.',
    '',
    `4. Write your ${CONVENTION_FILES.soul} now, using your file-editing tools. It lives at \`.dork/${CONVENTION_FILES.soul}\` in your working directory and already contains a "Personality Traits" block fenced by \`${TRAIT_SECTION_START}\` and \`${TRAIT_SECTION_END}\` — leave that fenced block exactly as it is. Replace only the prose BELOW the \`${TRAIT_SECTION_END}\` marker with your persona: who you are in your own voice, what you take care of, how you go about it, and the boundaries you keep. Keep it concise.`,
    '',
    '5. After the file is written, confirm it in one or two sentences and propose ONE concrete first action you could take — as an offer, and wait for their go-ahead.',
    '',
    `Do not start the actual job yet — your own ${CONVENTION_FILES.soul} is the only file you touch now. Do not act on their project or run their work until they say go. Speak warmly and directly to the person throughout.`,
  ].join('\n');
}

/**
 * The origin → builder registry. Extend it by adding an origin to
 * {@link KickoffOrigin} and a builder here; nothing else needs to change.
 */
const KICKOFF_BUILDERS: Record<KickoffOrigin, KickoffBuilder> = {
  template: buildTemplateKickoff,
  'design-your-own': buildDesignYourOwnKickoff,
};

/**
 * The plain kickoff instruction for an origin (unfenced). Exposed for tests, for
 * the eval harness that drives the interview, and for a caller that wants to
 * inspect the copy; production triggers use {@link buildKickoffMessage}.
 *
 * @param origin - How the agent was created.
 * @param ctx - This agent's name and abilities.
 * @returns The plain first-turn instruction.
 */
export function buildKickoffInstruction(origin: KickoffOrigin, ctx: KickoffContext): string {
  return KICKOFF_BUILDERS[origin](ctx);
}

/**
 * The kickoff message to trigger the agent's first turn with — the instruction
 * fenced by {@link wrapKickoff} so it is delivered to the model but never
 * rendered as a user bubble (the honesty seam).
 *
 * @param origin - How the agent was created.
 * @param ctx - This agent's name and abilities.
 * @returns The fenced kickoff message ready to POST as the first turn.
 */
export function buildKickoffMessage(origin: KickoffOrigin, ctx: KickoffContext): string {
  return wrapKickoff(buildKickoffInstruction(origin, ctx));
}
