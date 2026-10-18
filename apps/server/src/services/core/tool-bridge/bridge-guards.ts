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
import { createRateLimiter, type RateLimiter } from '../../../http/rate-limiter.js';
import { countWhileRunning } from '../turn-power/live-outsider-turns.js';

// === Rate limits ===

/** One minute, the window both limits count over. */
const MINUTE_MS = 60_000;

/** Most `tools.call` and `tools.list` one computer sends in any minute, all its agents together. */
export const BRIDGE_CALLS_PER_COMPUTER_PER_MINUTE = 600;

/** Most `tools.call` one turn sends in any minute. */
export const BRIDGE_CALLS_PER_TURN_PER_MINUTE = 120;

/** The two sliding windows a bridged call is counted in. */
export interface BridgedToolRateLimits {
  /** Keyed by the proven computer id. */
  readonly perComputer: RateLimiter;
  /** Keyed by the hub's session id for the turn. */
  readonly perTurn: RateLimiter;
}

/**
 * Fresh limits, each its own set of buckets: the server's one sliding-window
 * limiter (`http/rate-limiter.ts`).
 *
 * @param policy - Override the per-minute limits, for tests.
 */
export function createBridgedToolRateLimits(
  policy: { perComputer?: number; perTurn?: number; windowMs?: number } = {}
): BridgedToolRateLimits {
  const windowMs = policy.windowMs ?? MINUTE_MS;
  return {
    perComputer: createRateLimiter({
      windowMs,
      limit: policy.perComputer ?? BRIDGE_CALLS_PER_COMPUTER_PER_MINUTE,
      maxKeys: 1_000,
    }),
    perTurn: createRateLimiter({
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
 * hub's gate, which never auto-approves a destructive tool for a bridged call.
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

/** Why a tool the gate refused did not run. */
const DENIED = 'That tool is not allowed for this agent right now.';

/** Every other failure inside the tool. */
const TOOL_FAILED = 'The tool could not finish.';

/** A code that names nothing about the hub: letters and underscores only. */
const PLAIN_CODE = /^[A-Za-z_]{1,64}$/;

/**
 * A runner's failure, said in fixed words. The tool's own sentence never
 * crosses: it can carry a path, a stack or a raw error from inside the hub.
 * A plain code (`NOT_ON_THIS_SURFACE`) is kept, since it names a rule and
 * nothing else; anything else becomes `tool_error`.
 *
 * @param code - The code the runner gave.
 */
export function fixedRefusal(code: string): { ok: false; code: string; message: string } {
  if (code === 'denied') return { ok: false, code, message: DENIED };
  return { ok: false, code: PLAIN_CODE.test(code) ? code : 'tool_error', message: TOOL_FAILED };
}
