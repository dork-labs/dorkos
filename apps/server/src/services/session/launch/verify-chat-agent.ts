/**
 * Verify that a chat's claimed agent still exists and is allowed to start a
 * turn. Incoming messages and boot recovery share the registered-path check so
 * durable session metadata cannot outlive or move away from its Mesh identity.
 *
 * @module services/session/launch/verify-chat-agent
 */
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
  /** The exact agent directory claimed by the chat. */
  agentPath: string;
  /** The resolved turn identity. Omit when checking only the durable claim. */
  turn?: Exclude<TurnAgentOpts, undefined>;
}

/** Why a claimed chat agent cannot start a turn. */
export type ChatAgentRefusal =
  { reason: 'agent-not-registered' } | { reason: 'agent-paused'; agent: PausedAgentRef };

/**
 * Whether Mesh currently knows this exact agent directory.
 *
 * @param agentPath - The directory claimed by a message or stored chat.
 * @param deps - The live Mesh path reader.
 */
export function isRegisteredChatAgentPath(
  agentPath: string,
  deps: Pick<VerifyChatAgentDeps, 'registeredAgentPaths'>
): boolean {
  return deps.registeredAgentPaths()?.includes(agentPath) ?? false;
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
  if (!isRegisteredChatAgentPath(input.agentPath, deps)) {
    return { reason: 'agent-not-registered' };
  }
  if (input.turn === undefined) return undefined;
  const paused = deps.pausedAgentOfTurn(input.turn);
  return paused ? { reason: 'agent-paused', agent: paused } : undefined;
}
