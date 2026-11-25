/**
 * Verify that a chat's claimed agent still exists and is allowed to start a
 * turn. Incoming messages and boot recovery share the registered-path check so
 * durable session metadata cannot outlive or move away from its Mesh identity.
 * A folder spelled through a symlink is the same folder, matched by real path.
 *
 * @module services/session/launch/verify-chat-agent
 */
import { canonicalDir } from '../../core/agent-identity/index.js';
import type { PausedAgentRef, TurnAgentOpts } from '../../mesh/pause/agent-pause.js';

/** Collaborators for {@link verifyChatAgent}, injectable without module mocks. */
export interface VerifyChatAgentDeps {
  /** The exact agent directories Mesh currently knows, or `undefined` without Mesh. */
  registeredAgentPaths(): string[] | undefined;
  /** Find the paused agent that owns a resolved turn, when any. */
  pausedAgentOfTurn(opts: TurnAgentOpts): PausedAgentRef | undefined;
}

/** The stored agent and, after place resolution, the turn it would start. */
export interface VerifyChatAgentInput {
  /** The agent directory claimed by the chat, in any spelling of the folder. */
  agentPath: string;
  /** The resolved turn identity. Omit when checking only the durable claim. */
  turn?: Exclude<TurnAgentOpts, undefined>;
}

/** Why a claimed chat agent cannot start a turn. */
export type ChatAgentRefusal =
  { reason: 'agent-not-registered' } | { reason: 'agent-paused'; agent: PausedAgentRef };

/**
 * The registered agent directory `agentPath` IS, in the registry's own
 * spelling, or `undefined` when it is none of them.
 *
 * Exact first. On a miss, the same folder reached by another spelling — a
 * symlinked home or agents folder, macOS's `/var` and `/private/var` — matches
 * by real path (DOR-5117). Never a prefix, and never a guess: a real path two
 * registered directories share answers `undefined`, so an alias can only ever
 * name exactly one registered agent.
 *
 * @param agentPath - The directory claimed by a message or stored chat.
 * @param registered - The registered directories to match against.
 */
export function registeredSpellingOf(
  agentPath: string,
  registered: readonly string[] | undefined
): string | undefined {
  if (!registered) return undefined;
  if (registered.includes(agentPath)) return agentPath;
  const real = canonicalDir(agentPath);
  const matches = registered.filter((home) => canonicalDir(home) === real);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The registered spelling of the agent directory a message or stored chat
 * claims, or `undefined` when Mesh does not know that folder — see
 * {@link registeredSpellingOf}.
 *
 * @param agentPath - The directory claimed by a message or stored chat.
 * @param deps - The live Mesh path reader.
 */
export function registeredChatAgentPath(
  agentPath: string,
  deps: Pick<VerifyChatAgentDeps, 'registeredAgentPaths'>
): string | undefined {
  return registeredSpellingOf(agentPath, deps.registeredAgentPaths());
}

/**
 * Verify a chat's stored agent claim, then its pause after place resolution.
 *
 * @param input - The stored agent and optional resolved turn identity.
 * @param deps - Live Mesh and pause readers.
 * @returns The refusal, or `undefined` when the turn may start.
 */
export function verifyChatAgent(
  input: VerifyChatAgentInput,
  deps: VerifyChatAgentDeps
): ChatAgentRefusal | undefined {
  if (registeredChatAgentPath(input.agentPath, deps) === undefined) {
    return { reason: 'agent-not-registered' };
  }
  if (input.turn === undefined) return undefined;
  const paused = deps.pausedAgentOfTurn(input.turn);
  return paused ? { reason: 'agent-paused', agent: paused } : undefined;
}
