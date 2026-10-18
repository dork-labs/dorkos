/**
 * The tool bridge's guards that are not about which tool it is (DOR-2939 part
 * 6): how often a computer and a turn may call, what a turn's permission mode
 * lets a DorkOS tool do, how the outsider cap reaches the hub's own gate, and
 * the fixed sentences every refusal is said in.
 *
 * @module services/core/tool-bridge/bridge-guards
 */
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { StreamEvent } from '@dorkos/shared/types';
import { createProvenIdRateLimiter } from '../../../http/rate-limiter.js';
import { countWhileRunning } from '../turn-power/live-outsider-turns.js';
import {
  getAgentIdentityService,
  type AgentIdentityService,
} from '../agent-identity/agent-identity-service.js';

// === Rate limits ===

/** One minute, the window both limits count over. */
const MINUTE_MS = 60_000;

/** Most `tools.call` and `tools.list` one computer sends in any minute, all its agents together. */
export const BRIDGE_CALLS_PER_COMPUTER_PER_MINUTE = 600;

/** Most `tools.call` one turn sends in any minute. */
export const BRIDGE_CALLS_PER_TURN_PER_MINUTE = 120;

/** One sliding window, keyed by a server-proven id. */
type ProvenIdRateLimiter = ReturnType<typeof createProvenIdRateLimiter>;

/** The two sliding windows a bridged call is counted in. */
export interface BridgedToolRateLimits {
  /** Keyed by the proven computer id. */
  readonly perComputer: ProvenIdRateLimiter;
  /** Keyed by the hub's session id for the turn. */
  readonly perTurn: ProvenIdRateLimiter;
}

/**
 * Fresh limits, each its own set of buckets: the server's one sliding-window
 * limiter, keyed by the ids the bridge proved (`createProvenIdRateLimiter` in
 * `http/rate-limiter.ts`), since a bridged call has no request to key on.
 *
 * @param policy - Override the per-minute limits, for tests.
 */
export function createBridgedToolRateLimits(
  policy: { perComputer?: number; perTurn?: number; windowMs?: number } = {}
): BridgedToolRateLimits {
  const windowMs = policy.windowMs ?? MINUTE_MS;
  return {
    perComputer: createProvenIdRateLimiter({
      windowMs,
      limit: policy.perComputer ?? BRIDGE_CALLS_PER_COMPUTER_PER_MINUTE,
      maxKeys: 1_000,
    }),
    perTurn: createProvenIdRateLimiter({
      windowMs,
      limit: policy.perTurn ?? BRIDGE_CALLS_PER_TURN_PER_MINUTE,
      maxKeys: 10_000,
    }),
  };
}

// === The turn's permission mode ===

/**
 * The modes whose turn only reads. A DorkOS tool that changes anything is
 * refused in one, as the runtime would hold its own tools to reads.
 */
const READ_ONLY_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(['plan']);

/**
 * Whether a turn's permission mode lets a tool of this tier run. Only a
 * read-only mode refuses anything: every other mode leaves the decision to the
 * hub's gate, which asks a person before every destructive tool a bridged call
 * makes (`via: 'agent-computer'` on the identity, `resolveCallPermission`).
 *
 * @param mode - The turn's mode, from the hub's record.
 * @param tier - The tool's tier.
 */
export function modeAllows(mode: PermissionMode, tier: CapabilityTier): boolean {
  return tier === 'observe' || !READ_ONLY_MODES.has(mode);
}

// === The outsider cap ===

/**
 * Run `work` with the agent counted as reading an outsider's words, when the
 * turn is capped. The hub's own gate reads that count for every caller it
 * cannot place in a session, which a bridged call is (`turn-power/
 * live-outsider-turns.ts`): a destructive action or a permission change then
 * asks, whatever the agent's areas say, and a note it saves is marked.
 *
 * @param capped - Whether the hub's record caps the turn.
 * @param agentPath - The agent's home on the hub.
 * @param work - The tool run.
 */
export async function withOutsiderCap<T>(
  capped: boolean,
  agentPath: string,
  work: () => Promise<T>
): Promise<T> {
  if (!capped) return work();
  let result: { value: T } | undefined;
  // A stream with no events whose one read runs `work`, so the count spans it.
  const run: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        result ??= { value: await work() };
        return { done: true, value: undefined };
      },
    }),
  };
  for await (const _event of countWhileRunning({ cwd: agentPath }, run)) {
    // `run` has no events.
  }
  return result!.value;
}

// === Refusals in fixed words ===

/**
 * Every code a runner's failure may cross with, and the one sentence each is
 * said in. Anything else (`ENOENT`, a handler's own code) is `tool_error`:
 * the tool's own words never cross, since they can carry a path, a stack or a
 * raw error from inside the hub.
 */
const FIXED_REFUSALS: Readonly<Record<string, string>> = {
  denied: 'That tool is not allowed for this agent right now.',
  tool_error: 'The tool could not finish.',
};

/** A failure, said in fixed words. */
export type FixedRefusal = { ok: false; code: string; message: string };

/**
 * A runner's failure, said in fixed words: one of {@link FIXED_REFUSALS}.
 *
 * @param code - The code the runner gave.
 */
export function fixedRefusal(code: string): FixedRefusal {
  const known = Object.hasOwn(FIXED_REFUSALS, code) ? code : 'tool_error';
  return { ok: false, code: known, message: FIXED_REFUSALS[known]! };
}

/**
 * Whether a tool's ordinary answer is really the gate refusing it: a `denied`
 * payload, which names areas and settings, crosses only as {@link fixedRefusal}.
 *
 * @param output - The tool's answer.
 */
export function isDeniedPayload(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { status?: unknown }).status === 'denied'
  );
}

// === The agent's standing ===

/**
 * Whether an agent is shut off, as the agent-identity service records it: its
 * tokens revoked or run out. The live `agent` dependency of the bridge reads
 * this, so a bridged call is blocked exactly as the same agent's `/mcp` call
 * would be. An agent that never held a token is not shut off.
 *
 * @param agentPath - The agent's home on the hub.
 * @param service - The identity service; defaults to the live one.
 */
export async function agentInactiveOf(
  agentPath: string,
  service: Pick<AgentIdentityService, 'describeAgent'> | undefined = getAgentIdentityService()
): Promise<'revoked' | 'expired' | undefined> {
  return (await service?.describeAgent(agentPath))?.inactive;
}
