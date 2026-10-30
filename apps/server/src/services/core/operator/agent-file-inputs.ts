/**
 * The convention files `update_agent` writes, as input fields: `SOUL.md`
 * (`soulContent`) and `HEARTBEAT.md` (`heartbeatContent`), and the rule that
 * keeps a turn that read outsider words from rewriting them (DOR-3037). Split
 * out of `operator-capabilities.ts` to keep that file inside its line budget.
 *
 * @module services/core/operator/agent-file-inputs
 */
import { z } from 'zod';
import {
  HEARTBEAT_MAX_CHARS,
  NOPE_MAX_CHARS,
  SOUL_MAX_CHARS,
} from '@dorkos/shared/convention-files';
import { CapabilityToolError } from '../capabilities/mcp-envelope.js';
import { marksOf } from '../turn-power/turn-levels.js';
import { marksHold } from '../turn-power/turn-marks.js';
import { choseFullAutonomy } from '../turn-power/full-autonomy.js';

/** `update_agent_boundaries`' fields, spread into its input schema. */
export const AGENT_BOUNDARY_INPUTS = {
  nopeContent: z
    .string()
    .max(NOPE_MAX_CHARS)
    .optional()
    .describe('Full NOPE.md content, replacing whatever is there now'),
  // The mute, on the same gate as the rewrite because it is the STRONGER
  // of the two: the file survives, and the agent is simply never given it
  // (`runtimes/shared/agent-context.ts` skips the whole
  // `<agent_safety_boundaries>` block on `conventions.nope !== true`).
  // Leaving it on `update_agent` at tier `act` would have left a quieter
  // door to the same outcome, which is the defect this split exists to
  // close (DOR-1698).
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Whether the agent is given NOPE.md at all. false mutes the boundaries without ' +
        'deleting them; true puts them back.'
    ),
};

/** `update_agent`'s convention-file fields, spread into its input schema. */
export const AGENT_FILE_INPUTS = {
  // Says what DorkOS does with it, because the honest answer is not "we
  // store this". The personality block at the top of SOUL.md is rendered
  // from `traits` and fenced by markers the turn regenerates in place; a
  // file saved without them has no block to regenerate, so the six dials
  // stop reaching the agent entirely. The server composes the file around
  // that block either way (`agent-updater.ts`), and this sentence is what
  // keeps a caller from spending its budget reproducing a block it does
  // not own. Found by the `agent-self-edit` eval, 2026-09-12.
  soulContent: z
    .string()
    .max(SOUL_MAX_CHARS)
    .optional()
    .describe(
      'SOUL.md: who this agent is, in prose. Send the prose only — DorkOS keeps the ' +
        'personality block at the top of the file and writes it from `traits`. That block ' +
        `spends several hundred of the ${SOUL_MAX_CHARS.toLocaleString('en-US')}-character ` +
        'file budget, so your text has a few hundred less than that; a refusal names the ' +
        'exact number for this agent.'
    ),
  // HEARTBEAT.md (spec `heartbeats` §2): the agent's own job, so act-then-
  // tell. The frontmatter is validated at the next beat; an invalid one
  // keeps the last good one in force and is recorded once.
  heartbeatContent: z
    .string()
    .max(HEARTBEAT_MAX_CHARS)
    .optional()
    .describe(
      'HEARTBEAT.md: how this agent wakes between conversations and what it watches. ' +
        'YAML frontmatter (wake: timed | events | off; watch; report: daily | weekly | off; ' +
        'sweep) then a markdown checklist. Replaces the whole file; applies at the next beat.'
    ),
};

/** What a turn that read outsider words reads when it tries to rewrite these files. */
export const AGENT_FILES_OUTSIDER_REFUSAL =
  "This turn read words DorkOS can't vouch for, such as a Wi-Fi sign-in's, so it " +
  "can't change the agent's instructions, such as SOUL.md or HEARTBEAT.md. Ask the person " +
  'to change them at ' +
  'the computer DorkOS runs on.';

/**
 * Every agent field that becomes instructions its runtime reads, or decides
 * which of them it is given: SOUL.md, NOPE.md, MEMORY.md and HEARTBEAT.md, the
 * persona and its switch, the personality dials SOUL.md is rendered from, and
 * the convention switches. One list for the HTTP routes and `update_agent`
 * (DOR-3037).
 */
export const AGENT_INSTRUCTION_FIELDS = [
  'soulContent',
  'nopeContent',
  'memoryContent',
  'heartbeatContent',
  'persona',
  'personaEnabled',
  'traits',
  'conventions',
] as const;

/**
 * Whether a write names a limit a person set, refused for every agent at every level (DOR-3412,
 * DOR-3440): MEMORY.md holds what the operator told it in a one-to-one chat under a stamp only DorkOS
 * writes, and its switch decides whether it is read at all. NOPE.md and its switch are refused for
 * every caller by `update_agent` itself, which says where the write does live. The other switches
 * are the agent's own.
 */
function namesPersonSetField(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const { memoryContent, conventions } = input as {
    memoryContent?: unknown;
    conventions?: unknown;
  };
  if (memoryContent !== undefined) return true;
  return (
    typeof conventions === 'object' &&
    conventions !== null &&
    (conventions as { memory?: unknown }).memory !== undefined
  );
}

/**
 * The instruction fields a write names, in {@link AGENT_INSTRUCTION_FIELDS}.
 *
 * @param body - The write's body, any shape.
 */
export function namedInstructionFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  return AGENT_INSTRUCTION_FIELDS.filter(
    (key) => (body as Record<string, unknown>)[key] !== undefined
  );
}

/**
 * Refuse `update_agent` rewriting SOUL.md, HEARTBEAT.md or the persona from a
 * turn that read words DorkOS cannot vouch for (DOR-3037): a beat runs at the
 * agent's own level, so a HEARTBEAT.md written from a Wi-Fi turn would carry
 * that turn's words past its cap. Read from the turn's own record, never from
 * the model. Throws the tool's refusal; answers `undefined` when the call may
 * go on, so a capability can chain its handler after it with `??`.
 *
 * Not in a chat set to Full autonomy (DOR-3412), for the agent's own words (SOUL.md,
 * HEARTBEAT.md, the persona and the dials): they are not a level or a grant, so they are none of
 * the refusals Full keeps. The Activity line is the permission gate's, which writes one for every
 * `update_agent` a marked Full turn runs (`HELD_IN_A_MARKED_TURN`). A person's limits
 * ({@link namesPersonSetField}) are refused at every level.
 *
 * @param input - The tool's parsed input.
 * @param context - The verified calling session and agent.
 */
export function refuseOutsiderAgentFiles(
  input: unknown,
  context: { sessionId?: string; identity?: { agentPath: string } }
): undefined {
  const fields = namedInstructionFields(input);
  if (fields.length === 0) return undefined;
  const personSet = namesPersonSetField(input);
  // A person's limits: refused for every agent, marked or not (DOR-3440, Security's Must).
  const fromAgent = context.sessionId !== undefined || context.identity !== undefined;
  const marks = marksOf(context.sessionId, context.identity?.agentPath);
  if (!(personSet && fromAgent)) {
    if (!marksHold(marks)) return undefined;
    if (choseFullAutonomy(context.sessionId)) return undefined;
  }
  throw new CapabilityToolError({
    error: AGENT_FILES_OUTSIDER_REFUSAL,
    code: 'outsider-held',
    fields,
  });
}
