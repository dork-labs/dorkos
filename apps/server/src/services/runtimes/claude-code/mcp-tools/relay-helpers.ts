/**
 * Shared helpers for Relay MCP tool handlers.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-helpers
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import {
  homeOf,
  resolveAgentHome,
  type HomeResolution,
} from '../../../core/agent-identity/index.js';

/** Sender identity injected on the external `/mcp` surface (no per-session context). */
export const EXTERNAL_MCP_SENDER = 'relay.external.mcp';

/** Server-resolved identity of the principal behind a Relay tool call. */
export interface SenderIdentity {
  /**
   * Relay subject used as the publish `from`. Namespace deny/allow rules
   * (written by RelayBridge) match on the agent subject `relay.agent.{ns}.{id}`,
   * so this is the value access control keys on.
   */
  subject: string;
  /**
   * Mesh agent id — present only when the session maps to a registered agent.
   * Used by `relay_notify_user` to resolve the caller's own integration bindings.
   */
  agentId?: string;
}

/**
 * Resolve the trusted sender identity for a Relay publish, server-side.
 *
 * The relay `from` is an authorization principal, not a label: namespace
 * deny/allow rules match on the agent's subject `relay.agent.{ns}.{id}`. Letting
 * the LLM assert its own `from` (or `agentId`) lets any agent claim another
 * identity and bypass those rules, so identity is derived from the session's
 * working directory rather than from tool arguments.
 *
 * - Registered agent (a manifest at `cwd`): its canonical subject via
 *   `meshCore.getSubjectByPath()`, which reads the UN-stripped registry entry —
 *   the same resolved namespace RelayBridge registered the endpoint and ACL
 *   rules with. (`getByPath()` cannot be used here: it returns a public
 *   manifest with `namespace` stripped, which would silently degrade the
 *   subject to `basename(cwd)` and match no rule for nested or
 *   explicit-namespace agents.)
 * - Any other session (or the external `/mcp` surface, `cwd` undefined): a
 *   deterministic, non-agent identity so the sender is still stable and
 *   unspoofable — no agent ACL rules apply to it. Suffixed with a short hash
 *   of the FULL `cwd` (DOR-514), not bare `path.basename(cwd)`: two unrelated
 *   projects that happen to share a leaf directory name — `/a/project` and
 *   `/b/project` — used to collide on one `relay.session.project` identity.
 *   No agent ACL rule keys on this subject, so the collision was pre-existing
 *   and mild rather than the in-session escalation DOR-506 closed, but it is
 *   cheap to remove. Keeping the basename in front of the hash (rather than
 *   hashing it away entirely) is deliberate: `classify-origin.ts` renders
 *   this subject's last segment as a session's origin label (e.g. "myproject
 *   (agent)") — a bare hash there reads as "e549f2e8 (agent)", which answers
 *   "is this the same session as before" but not "whose session is this,"
 *   the question the label exists to answer. `${basename}-${hash}` keeps
 *   both: legible AND distinct even when two projects share a leaf name.
 *
 * **The registry is asked about the session's identity ANCHOR, not its
 * directory** (DOR-2091). A room turn in a room with files stands in the agent's
 * worktree, which hosts no agent; the anchor is the agent that worktree was
 * handed to. A REFUSED anchor — a working copy nobody can vouch for, or one that
 * is not the turn's agent's — asks the registry nothing and gets the non-agent
 * session subject, so it can neither send as an agent nor as anybody's
 * integration owner.
 *
 * @param deps - Tool dependencies, for the Mesh registry lookup
 * @param cwd - The session's working directory, when known
 * @param anchor - Whose identity the session carries; defaults to the home
 *   `cwd` resolves to
 */
export function resolveSenderIdentity(
  deps: McpToolDeps,
  cwd: string | undefined,
  anchor: HomeResolution = resolveAgentHome(cwd)
): SenderIdentity {
  const agentPath = homeOf(anchor);
  if (agentPath && deps.meshCore) {
    const identity = deps.meshCore.getSubjectByPath(agentPath);
    if (identity) return identity;
  }
  return { subject: cwd ? `relay.session.${sessionSubjectSegment(cwd)}` : EXTERNAL_MCP_SENDER };
}

/**
 * A legible, deterministic, filesystem-path-safe stand-in for a full `cwd` in
 * a Relay subject: the directory's own leaf name, plus a short hash of the
 * FULL path so two directories sharing a leaf name never collide. The hash is
 * not for secrecy — a subject is not a secret — only for distinctness.
 *
 * @param cwd - The session's working directory.
 */
function sessionSubjectSegment(cwd: string): string {
  const hash = createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 8);
  return `${path.basename(cwd)}-${hash}`;
}

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in RelayCore and ClaudeCodeAdapter.
 * Inlined here to avoid a runtime dependency on the @dorkos/relay dist output.
 */
export function inferEndpointType(
  subject: string
): 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown' {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}

/** Guard that returns an error response when Relay is disabled. */
export function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}
