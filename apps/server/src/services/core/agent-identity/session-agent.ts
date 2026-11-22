/**
 * The agent a chat belongs to, for checks that compare it with a caller (DOR-5035).
 *
 * A chat started with only a folder (by the API, the CLI or an older client) is
 * bound with `agent_path` NULL, and the binding is first-write-wins, so it stays
 * NULL. The poster's identity still resolves from that folder, so a reader that
 * compares the two on the recorded value alone refuses the chat's own agent.
 * These read the recorded agent first, then the agent whose home the chat's
 * folder resolves to, by the same resolver the poster's identity comes from.
 * The folder is the stored native location, else the one its runtime is running
 * it in now; both are server-held, never a caller's claim. Read-side only:
 * nothing is written back. So a chat with no stored folder names nobody once
 * its runtime no longer holds it (a restart, an idle reclaim), and checks that
 * read it then refuse rather than guess. One exception: a hand-off's end notice
 * lets the witness checked at admission stand for an unknown agent (DOR-5040).
 * Claiming and running the hand-off still refuse one, so a chat dropped before
 * its seat runs has the hand-off declined, and hears that it ended unposted.
 *
 * @module server/services/core/agent-identity/session-agent
 */
import {
  eq,
  sessionMetadata,
  sessionNativeBindings,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { homeOf, resolveAgentHome } from './agent-home.js';
import { runtimeRegistry } from '../runtime-registry.js';

/** What the resolver reads from the rest of the server, wired once at boot. */
export interface SessionAgentSources {
  /** The folder the chat's own runtime is running it in now, from that runtime's memory. */
  liveCwd(sessionId: string): string | undefined;
  /** The server's database, for {@link sessionAgentById}'s callers, which hold none. */
  db?: Db;
}

let sources: SessionAgentSources | undefined;

/**
 * Register (or clear) what {@link sessionAgentOf} reads beyond the database it is handed.
 * Unwired, a chat bound without an agent resolves only from its stored location.
 *
 * @param port - The live lookups, or `undefined` to clear them.
 */
export function setSessionAgentSources(port: SessionAgentSources | undefined): void {
  sources = port;
}

/**
 * The chat's agent from its stored agent and its folder: the recorded agent,
 * else the registered home the folder resolves to. A folder that is no agent's,
 * or one the resolver refuses, answers `undefined`: a caller comparing it with a
 * poster fails closed. A caller that must tell these apart reads
 * {@link chatAgentStateOf}.
 *
 * @param recorded - The `agent_path` recorded for the chat at launch.
 * @param cwd - The folder the chat runs in, when one is known.
 */
export function agentOfChat(
  recorded: string | null | undefined,
  cwd: string | null | undefined
): string | undefined {
  if (recorded) return recorded;
  return cwd ? homeOf(resolveAgentHome(cwd)) : undefined;
}

/**
 * What is known about a chat's agent (DOR-5040):
 *
 * - `agent`: the recorded agent, or the registered home its folder resolves to;
 * - `unknown`: no agent was recorded and no folder is known any more (the
 *   runtime no longer holds the chat, and none was stored);
 * - `nobody`: its folder is known and is no agent's;
 * - `refused`: the resolver refused its folder.
 */
export type ChatAgentState =
  | { kind: 'agent'; agentPath: string }
  | { kind: 'unknown' }
  | { kind: 'nobody' }
  | { kind: 'refused' };

/**
 * The chat's agent state, read from the database the caller is already in, so
 * a transaction's checks see one snapshot.
 *
 * @param db - The database or open transaction.
 * @param sessionId - The chat.
 */
export function chatAgentStateOf(db: Db | DbTransaction, sessionId: string): ChatAgentState {
  const metadata = db
    .select({ agentPath: sessionMetadata.agentPath })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  if (metadata?.agentPath) return { kind: 'agent', agentPath: metadata.agentPath };
  const stored = db
    .select({ cwd: sessionNativeBindings.cwd })
    .from(sessionNativeBindings)
    .where(eq(sessionNativeBindings.sessionId, sessionId))
    .get()?.cwd;
  const cwd = stored || liveSessionCwd(sessionId);
  if (!cwd) return { kind: 'unknown' };
  const resolved = resolveAgentHome(cwd);
  if (resolved.kind === 'refused') return { kind: 'refused' };
  const home = homeOf(resolved);
  return home ? { kind: 'agent', agentPath: home } : { kind: 'nobody' };
}

/**
 * The chat's agent, read from the database the caller is already in: the
 * agent of {@link chatAgentStateOf}, or `undefined` for every other state.
 *
 * @param db - The database or open transaction.
 * @param sessionId - The chat.
 */
export function sessionAgentOf(db: Db | DbTransaction, sessionId: string): string | undefined {
  const state = chatAgentStateOf(db, sessionId);
  return state.kind === 'agent' ? state.agentPath : undefined;
}

/**
 * {@link sessionAgentOf} for a caller that holds only the chat's id (the relay,
 * a carry-over), read from the database wired at boot (DOR-5038). Before that,
 * only the recorded agent is known, so it answers that: what these callers read
 * before, never less. A database failure rejects; callers decide what it means.
 *
 * @param sessionId - The chat.
 */
export async function sessionAgentById(sessionId: string): Promise<string | undefined> {
  if (sources?.db) return sessionAgentOf(sources.db, sessionId);
  return (await runtimeRegistry.getSessionAgentPath(sessionId)) ?? undefined;
}

/**
 * The folder the chat's runtime is running it in now, or `undefined` when no
 * runtime holds it (after a restart, or unwired).
 *
 * @param sessionId - The chat.
 */
export function liveSessionCwd(sessionId: string): string | undefined {
  return sources?.liveCwd(sessionId);
}
