/**
 * Kickoff prompts — the synthetic first-turn instruction a freshly created
 * agent receives so it speaks first (M4, "it's alive"). Keyed by creation
 * origin so each way an agent can be born supplies its own opening.
 *
 * This PR ships two origins:
 * - `template` — the agent arrived with a persona/soul (a gallery pick, a
 *   Shape's offered agent, a marketplace agent). It introduces itself from its
 *   SOUL.md and OFFERS a first action — it does not start working unprompted.
 * - `generic` — "Design your own" with no persona yet. It says a graceful hello
 *   and asks what the person wants it to take care of.
 *
 * The design-your-own INTERVIEW (write SOUL.md live in the conversation) is a
 * separate, richer origin the next agent adds by registering another builder in
 * {@link KICKOFF_BUILDERS} — no rearchitecture, just a new entry keyed by its
 * own origin.
 *
 * @module features/agent-creation/lib/kickoff-prompts
 */
import { wrapKickoff } from '@dorkos/shared/kickoff';

/** Which opening a newborn agent gets, keyed by how it was created. */
export type KickoffOrigin = 'template' | 'generic';

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
    'Read your SOUL.md to recall who you are, then, in 2 to 4 short sentences:',
    '- Introduce yourself in your own voice, drawn from that persona.',
    '- State plainly what your job is.',
    '- Propose one concrete first action you could take — as an offer, and wait for their go-ahead.',
    '',
    'Do NOT start any work yet — do not act on the project or change any files. (Reading your own SOUL.md so you can introduce yourself is fine; anything beyond that waits for their go-ahead.) Just make the offer and let them decide. Speak warmly and directly to the person.' +
      abilities,
  ].join('\n');
}

/**
 * A blank agent's opening: a warm hello and an open question. It claims no role
 * and starts no work — the person's answer defines the job.
 */
function buildGenericKickoff(ctx: KickoffContext): string {
  return [
    `You have just been created${ctx.displayName ? ` and named ${ctx.displayName}` : ''}, and you do not have a defined job yet — the person who made you will tell you what they need.`,
    '',
    "Say a brief, warm hello (1 to 2 sentences), then ask them what they'd like you to take care of.",
    '',
    'Do not assume a role or start any work — just open the conversation and wait for their answer.',
  ].join('\n');
}

/**
 * The origin → builder registry. Extend it by adding an origin to
 * {@link KickoffOrigin} and a builder here; nothing else needs to change.
 */
const KICKOFF_BUILDERS: Record<KickoffOrigin, KickoffBuilder> = {
  template: buildTemplateKickoff,
  generic: buildGenericKickoff,
};

/**
 * The plain kickoff instruction for an origin (unfenced). Exposed mainly for
 * tests and for a caller that wants to inspect the copy; production triggers use
 * {@link buildKickoffMessage}.
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
