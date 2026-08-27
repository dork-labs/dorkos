/**
 * The one answer to "which directory does this turn run in?".
 *
 * Before this module, three surfaces re-derived that answer differently: the
 * session route used the request's `cwd` and nothing else, the task scheduler
 * resolved an agent-linked task to `MeshCore.getProjectPath`, and the relay
 * binding router stamped `cwd: projectPath` onto its dispatch payload. All three
 * happened to agree while every agent worked in its own folder — and all three
 * would have disagreed the moment one agent asked for a checkout of its own.
 * So: one resolver, one precedence chain, one log line naming which rung won.
 *
 * ## The chain, first match wins
 *
 * 1. **`explicit`** — the caller named a `cwd`. Nothing else is consulted, and
 *    the path is passed through untouched. This rung is what keeps every
 *    cockpit turn, every already-resolved task and every relay dispatch
 *    byte-for-byte what it was.
 * 2. **`room-worktree`** — DECLARED, NOT WIRED. A room turn in a repo-enabled
 *    room will resolve to that agent's standing worktree in the room's repo.
 *    Task 2.2 of the project-rooms programme wires it (spec `project-rooms`
 *    §3.5); until then {@link resolveSessionCwd} never returns this rung. It is
 *    named here so the type is the whole chain rather than most of it.
 * 3. **`agent-home` / `agent-managed`** — an agent was named, and its manifest
 *    says where it works ({@link AgentWorkspaceBindingSchema}).
 * 4. **`default`** — nobody had a better answer, so `DEFAULT_CWD`. Not a lazy
 *    fallback: it is the honest answer for an external MCP caller with no
 *    meaningful path, and it stays the machine-level default it always was.
 *
 * ## Two invariants
 *
 * **Failure never fails the turn.** A binding that cannot be honored — an
 * unreadable manifest, a provisioning failure, a path outside the boundary —
 * degrades to a lower rung carrying a `degraded` reason. A turn that cannot get
 * its preferred tree still runs. Degradation goes ONE rung, to the agent's own
 * folder, rather than all the way out to `DEFAULT_CWD` — see
 * {@link resolveAgentBinding} for why that difference matters.
 *
 * **The binding resolves exactly once per turn, at the session boundary, before
 * the runtime is invoked.** A subagent is the same agent doing the same task, so
 * it stays in the tree; a peer agent reached over Relay or Mesh is a different
 * agent, so it gets its own session, its own `agentPath` and its own binding.
 * Delegation down stays put; delegation across moves. Nothing inside a turn may
 * call this function — `__tests__/resolve-session-cwd.subagent.test.ts` enforces
 * that on the import graph, and explains there why a behavioral test could not.
 *
 * @module server/services/workspace/resolve-session-cwd
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readManifest } from '@dorkos/shared/manifest';
import {
  sanitizeWorkspaceKey,
  type EnsureWorkspaceRequest,
  type Workspace,
} from '@dorkos/shared/workspace';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { validateBoundary, validateBoundaryOrDorkHome } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { getWorkspaceManager } from './index.js';

/**
 * Which rung of the precedence chain answered.
 *
 * `room-worktree` is declared and not yet reachable — task 2.2 of the
 * project-rooms programme wires it (spec `project-rooms` §3.5).
 */
export type SessionCwdRung =
  'explicit' | 'room-worktree' | 'agent-home' | 'agent-managed' | 'default';

/** Where a turn runs, and why. */
export interface ResolvedCwd {
  /** The absolute working directory the runtime should be given. */
  cwd: string;
  /** Which rung answered — see {@link SessionCwdRung}. */
  rung: SessionCwdRung;
  /** The workspace id, when a `managed` binding provisioned or reused one. */
  workspaceId?: string;
  /** Why a lower rung answered than the binding asked for. Absent when none did. */
  degraded?: string;
}

/** What a caller knows about the turn it is about to start. */
export interface ResolveSessionCwdRequest {
  /** A working directory the caller already resolved. Wins outright. */
  cwd?: string;
  /** The directory of the agent this turn is for, when the caller knows it. */
  agentPath?: string;
  /** Falls back to this session's persisted `agent_path` when `agentPath` is absent. */
  sessionId?: string;
}

/**
 * Collaborators, injected so the resolver's table of cases can be tested
 * without a filesystem, a git binary or a bootstrapped server.
 */
export interface ResolveSessionCwdDeps {
  /** Read an agent's manifest from its directory. */
  readManifest(agentPath: string): Promise<AgentManifest | null>;
  /** Provision-or-reuse the workspace a `managed` binding asks for. */
  ensureWorkspace(req: EnsureWorkspaceRequest): Promise<Workspace>;
  /** The `agent_path` a session was bound with, or `null`. */
  sessionAgentPath(sessionId: string): Promise<string | null>;
  /** Boundary check for an agent's own directory (the agent-registry carve-out). */
  validateAgentHome(candidate: string): Promise<string>;
  /** Boundary check for a managed checkout (no carve-out — it is a raw tree). */
  validateManagedCheckout(candidate: string): Promise<string>;
  /** The server's default working directory. */
  defaultCwd: string;
}

/** The production collaborators. Resolved lazily so imports stay side-effect-free. */
function productionDeps(): ResolveSessionCwdDeps {
  return {
    readManifest: (agentPath) => readManifest(agentPath, logger),
    ensureWorkspace: (req) => getWorkspaceManager().ensure(req),
    sessionAgentPath: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId),
    validateAgentHome: (candidate) => validateBoundaryOrDorkHome(candidate),
    validateManagedCheckout: (candidate) => validateBoundary(candidate),
    defaultCwd: DEFAULT_CWD,
  };
}

/**
 * The `(projectKey, key)` pair an agent's managed checkout is keyed by.
 *
 * `projectKey` is the source repo's directory name, unchanged from how the
 * unit-of-work path derives it. `key` carries the agent's name so the directory
 * is legible on disk and in the `/workspaces` list, plus a digest of the agent's
 * PATH so two agents sharing a slug in different directories cannot collide —
 * and so the same agent derives the same key every time.
 *
 * The rejected alternative was a reserved `projectKey` such as `"agents"` with a
 * bare slug key: stringly-typed reserved-prefix magic, and it would file every
 * agent's checkout under one project key regardless of which repo it came from.
 *
 * @param manifestName - The agent's `name` (its slug).
 * @param agentPath - The agent's own directory — what makes the key collision-free.
 * @param source - The repository or directory the checkout is made from.
 */
export function agentWorkspaceKey(
  manifestName: string,
  agentPath: string,
  source: string
): { projectKey: string; key: string } {
  const digest = createHash('sha256').update(agentPath).digest('hex').slice(0, 8);
  return {
    projectKey: sanitizeWorkspaceKey(path.basename(source)),
    key: `agent-${sanitizeWorkspaceKey(manifestName)}-${digest}`,
  };
}

/**
 * Resolve the working directory for one turn.
 *
 * Called ONCE per turn, at the session boundary, before the runtime is invoked
 * — see the module doc's subagent invariant.
 *
 * @param req - What the caller knows about the turn.
 * @param deps - Injected collaborators; the production ones when omitted.
 * @returns The directory to run in, the rung that chose it, and any degradation.
 */
export async function resolveSessionCwd(
  req: ResolveSessionCwdRequest,
  deps: ResolveSessionCwdDeps = productionDeps()
): Promise<ResolvedCwd> {
  const resolved = await resolve(req, deps);
  // One line per turn naming the rung, the directory and any degradation.
  // Without it, "why is my agent writing there" is unanswerable, and a
  // precedence chain that cannot be interrogated is worse than the one-rung
  // chain it replaced.
  logger.info('[cwd] resolved', {
    rung: resolved.rung,
    cwd: resolved.cwd,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
    ...(resolved.degraded ? { degraded: resolved.degraded } : {}),
  });
  return resolved;
}

/** The chain itself, without the log line. */
async function resolve(
  req: ResolveSessionCwdRequest,
  deps: ResolveSessionCwdDeps
): Promise<ResolvedCwd> {
  // Rung 1. Deliberately NOT boundary-validated: an explicit cwd reaches the
  // runtime exactly as it did before this resolver existed, and the surfaces
  // that must confine a person-supplied path (file reads, terminal, git, the
  // directory browser) validate it themselves at their own edges. Validating
  // here would 403 turns that run today, which is the one thing this change
  // promised not to do.
  if (req.cwd) return { cwd: req.cwd, rung: 'explicit' };

  // Rung 2 (`room-worktree`) is not wired — task 2.2, spec `project-rooms` §3.5.

  const agentPath = req.agentPath ?? (req.sessionId ? await agentPathOf(req, deps) : null);
  if (agentPath) {
    const binding = await resolveAgentBinding(agentPath, deps);
    if (binding) return binding;
  }

  return { cwd: deps.defaultCwd, rung: 'default' };
}

/** The session's persisted `agent_path`, or `null` if it has none or cannot be read. */
async function agentPathOf(
  req: ResolveSessionCwdRequest,
  deps: ResolveSessionCwdDeps
): Promise<string | null> {
  if (!req.sessionId) return null;
  try {
    return await deps.sessionAgentPath(req.sessionId);
  } catch (err) {
    // A binding row that cannot be read is not a reason to fail a turn; the
    // chain simply has one less thing to go on.
    logger.warn('[cwd] could not read the session binding', {
      sessionId: req.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Rungs 3a/3b: what the agent's manifest says, honored or degraded.
 *
 * Returns `null` when the chain must fall through to `DEFAULT_CWD` for a reason
 * that is not a degradation — which is exactly one case, `mode: 'none'`, where
 * sharing the default folder is what the operator asked for.
 *
 * **Degradation lands on the agent's own folder, not on `DEFAULT_CWD`.** The
 * spec wrote the fallback as `DEFAULT_CWD`, and that is wrong on this rung for a
 * reason the spec did not have in front of it: reaching here means the CALLER
 * already knows the agent's directory. Sending the turn to the shared default
 * instead would move an agent's work out of its own tree over an unreadable file
 * — the very collision (DOR-500) this whole chain exists to stop. So an
 * unreadable manifest reads as `home`, exactly as an ABSENT `workspace` field
 * does, and a `managed` binding that cannot be provisioned falls back one rung
 * to `home` rather than all the way out. `DEFAULT_CWD` is reached only when the
 * agent's own folder is itself refused by the boundary.
 */
async function resolveAgentBinding(
  agentPath: string,
  deps: ResolveSessionCwdDeps
): Promise<ResolvedCwd | null> {
  let manifest: AgentManifest | null;
  try {
    manifest = await deps.readManifest(agentPath);
  } catch (err) {
    return home(agentPath, deps, `could not read the manifest at ${agentPath}: ${message(err)}`);
  }
  if (!manifest) {
    return home(agentPath, deps, `no readable agent manifest at ${agentPath}`);
  }

  const binding = manifest.workspace;
  if (binding.mode === 'none') return null;
  if (binding.mode === 'home') return home(agentPath, deps);

  try {
    const { projectKey, key } = agentWorkspaceKey(manifest.name, agentPath, binding.source);
    const workspace = await deps.ensureWorkspace({
      projectKey,
      key,
      source: binding.source,
      ...(binding.provider ? { provider: binding.provider } : {}),
      owner: { kind: 'agent', ref: agentPath },
    });
    return {
      cwd: await deps.validateManagedCheckout(workspace.path),
      rung: 'agent-managed',
      workspaceId: workspace.id,
    };
  } catch (err) {
    // Port pool exhausted, git failure, source repo missing, checkout outside
    // the boundary — every one of them lands here, and the turn still runs.
    return home(agentPath, deps, `could not provision the managed workspace: ${message(err)}`);
  }
}

/**
 * The agent-home rung, with the boundary check that makes the whole model safe.
 *
 * A manifest is agent-writable, so this is what stops a binding — however
 * written — from resolving anywhere the agent could not already reach. A refused
 * path is refused, not used: the chain falls to `DEFAULT_CWD` carrying both
 * reasons.
 *
 * @param agentPath - The agent's own directory.
 * @param deps - Injected collaborators.
 * @param reason - Why a lower rung is answering than the binding asked for.
 */
async function home(
  agentPath: string,
  deps: ResolveSessionCwdDeps,
  reason?: string
): Promise<ResolvedCwd> {
  try {
    return {
      cwd: await deps.validateAgentHome(agentPath),
      rung: 'agent-home',
      ...(reason ? { degraded: reason } : {}),
    };
  } catch (err) {
    const refusal = `agent home ${agentPath} is out of bounds: ${message(err)}`;
    return {
      cwd: deps.defaultCwd,
      rung: 'default',
      degraded: reason ? `${reason}; ${refusal}` : refusal,
    };
  }
}

/** The readable half of an unknown throw. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
