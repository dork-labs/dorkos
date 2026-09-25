/**
 * An agent's execution defaults, its runtime, model and effort, change only with
 * a person's say-so when an agent asks (DOR-2328).
 *
 * ## Why these three are gated
 *
 * A scheduled task that leaves its runtime, model or effort unset follows its
 * agent, and a person's approval of that schedule records the unset value
 * rather than the agent's (DOR-2323, ADR `260924-213416`). So whoever can move
 * an agent's defaults moves every such approved schedule with them: onto
 * another runtime, or a costlier model, with nobody asked. Putting the resolved
 * values into the schedule's approval instead would park every schedule that
 * follows an agent whenever a person tunes that agent, so the gate goes on the
 * write rather than on the schedule.
 *
 * ## Who is asked, on each door
 *
 * - `operator.update_agent` (tier `act`) refuses all three, whatever they hold,
 *   and points at `operator.update_agent_execution` (tier `destructive`), which
 *   puts a card in front of a person with every change old → new. The same
 *   split `update_agent_boundaries` made for NOPE.md (DOR-1698).
 * - `PATCH /api/agents/current` and `PATCH /api/mesh/agents/:id` refuse a caller
 *   that has not cleared the agent bar ({@link requestNamesExecutionField} plus the
 *   route's own caller check), with the same pointer. A person (the Runs-on
 *   popover, the agent settings page) is not asked.
 * - Creating or registering an agent is out of scope: a new agent has no
 *   schedules following it yet, and adopting a folder that already has a
 *   manifest ignores every override.
 *
 * ## A hand edit of `.dork/agent.json`
 *
 * Left to the person, on the same line DOR-2306 drew for files: a file on disk
 * is the person's domain, and DorkOS cannot tell the person's editor from an
 * agent's shell writing the same bytes (the residual `agent-write-policy.ts`
 * states for every field). What this module guarantees is that no DOOR DorkOS
 * serves writes these fields for an agent without the card, so an agent cannot
 * route its own MCP or REST request around the gate through a file DorkOS writes
 * for it. The reconciler only mirrors a file into the database; it never writes
 * the file, so it cannot be used to launder a change either.
 *
 * @module services/core/operator/agent-execution
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** The execution defaults this module gates, in the order a card lists them. */
export const AGENT_EXECUTION_FIELDS = ['runtime', 'model', 'effort'] as const;

/** One of {@link AGENT_EXECUTION_FIELDS}. */
export type AgentExecutionField = (typeof AGENT_EXECUTION_FIELDS)[number];

/** A change to an agent's execution defaults; `null` returns a value to the default. */
export type AgentExecutionChange = Partial<Record<AgentExecutionField, string | null>>;

/** The code a refusal carries, shared with the boundaries gate. */
export const EXECUTION_NEEDS_APPROVAL_CODE = 'NEEDS_APPROVAL';

/**
 * The sentence every door refuses an agent's change to these fields with. It
 * names the gated tool as a searchable ending and the CLI verb, because the
 * prefix a harness puts on a tool name is the person's choice (DOR-1292).
 */
export const EXECUTION_NEEDS_APPROVAL_MESSAGE =
  "An agent's runtime, model and effort are changed with the tool whose name ends in " +
  '`update_agent_execution` (or `dorkos call operator.update_agent_execution`); it asks a ' +
  'person to approve the change first, because every schedule that follows the agent would ' +
  'run differently. Nothing here was changed. Send the rest of this change again without them.';

/** How a card names each field. */
const LABEL: Record<AgentExecutionField, string> = {
  runtime: 'Runtime',
  model: 'Model',
  effort: 'Effort',
};

/**
 * Whether a request body names any of the gated fields at all, whatever it
 * holds. Naming one is a request about it, so it is refused whole rather than
 * quietly stripped (the DOR-1253 shape).
 *
 * @param body - A request body, as it arrived.
 */
export function requestNamesExecutionField(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return AGENT_EXECUTION_FIELDS.some((field) => Object.hasOwn(body, field));
}

/** The escapes a person recognises; any other control character is written `\uXXXX`. */
const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * One value as a card says it.
 *
 * Control characters are written out as escapes rather than passed through.
 * Both sides are untrusted text: `model` is free text in the request, and the
 * current value comes from a file an agent's shell can write. A raw newline in
 * either would draw a line of its own on the card, one the person would read as
 * a real change.
 */
function say(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'the default';
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    const breaksALine =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (!breaksALine) return char;
    return ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, '0')}`;
  }).join('');
}

/**
 * The card's lines for a change, old → new, one per field that actually
 * changes, or `undefined` when nothing would.
 *
 * @param current - The manifest as it stands.
 * @param change - The requested values.
 */
export function describeExecutionChange(
  current: Pick<AgentManifest, AgentExecutionField>,
  change: AgentExecutionChange
): string | undefined {
  const lines = AGENT_EXECUTION_FIELDS.filter(
    (field) => change[field] !== undefined && say(change[field]) !== say(current[field])
  ).map((field) => `${LABEL[field]}: ${say(current[field])} → ${say(change[field])}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** A refusal a route answers with. */
export interface AgentExecutionRefusal {
  /** The HTTP status. */
  status: 403;
  /** The body. */
  body: { error: string; code: string };
}

/**
 * The route half of the gate: refuse a request that names an execution field
 * unless its caller has cleared the agent bar, i.e. is a person (DOR-2328).
 *
 * Both agent-editing routes ask this, through `middleware/agent-execution-gate.ts`,
 * before anything is read or written. A
 * person (the Runs-on popover, the agent settings page) passes; a caller that
 * presents an agent identity or an approval token is sent to the tool that asks
 * a person. The same two bars the task routes run (`clearsTheAgentBar`): the
 * session cookie under login-on, and the agent bar in every posture. With login
 * off, a program that strips its agent header is indistinguishable from the
 * person, the residual every such route states (DOR-505).
 *
 * @param body - The request body, as it arrived.
 * @param clearsTheAgentBar - Whether the caller is a person, asked only when
 *   the body names a gated field.
 * @returns The refusal to answer with, or `undefined` to carry on.
 */
export function refuseAgentExecutionWrite(
  body: unknown,
  clearsTheAgentBar: () => boolean
): AgentExecutionRefusal | undefined {
  if (!requestNamesExecutionField(body) || clearsTheAgentBar()) return undefined;
  return {
    status: 403,
    body: { error: EXECUTION_NEEDS_APPROVAL_MESSAGE, code: EXECUTION_NEEDS_APPROVAL_CODE },
  };
}
