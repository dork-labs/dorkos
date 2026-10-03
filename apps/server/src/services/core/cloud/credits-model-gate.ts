/**
 * Who pays decides which models a session, an agent or a schedule may name
 * (DOR-2636): the questions every model write asks before it stores a model,
 * so the session picker, the agent settings, the agent's own self-edit tools,
 * agent creation and an agent starting a session all refuse the same models.
 *
 * - {@link sessionRunsOnCredits} / {@link agentRunsOnCredits}: whether the
 *   work runs on DorkOS credits, the same answer its launch reaches.
 * - {@link resolvedModelFor}: the id a runtime alias (`sonnet`) expands to, so
 *   an alias naming a served model is never refused.
 * - {@link creditsModelRefusal} / {@link creditsAgentModelRefusal}: the
 *   sentence to refuse with, or `null`. Judged only once the service says
 *   which protocols its models are on; before that, nothing changes.
 *
 * @module services/core/cloud/credits-model-gate
 */
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { validateBoundary } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { runtimeRegistry } from '../runtime-registry.js';
import type { LaunchAccountResolution } from '../../runtimes/claude-code/claude-config-dir.js';
import { creditsAllowedForAgent, creditsIsDefaultFor } from './credits-defaults.js';
import { judgeCreditsModel } from './credits-models.js';

/**
 * A runtime that can say which account one of its sessions launches on.
 * Structural, as in `resolve-session-account.ts`: accounts are a Claude Code
 * concept, and the port does not carry them.
 */
interface LaunchAccountAware {
  checkLaunchAccount(
    sessionId: string,
    projectDir: string,
    hintId?: string
  ): Promise<LaunchAccountResolution>;
}

/**
 * A runtime with no account ladder that can still say whether one of its
 * sessions runs on DorkOS credits. Structural, like {@link LaunchAccountAware}.
 */
interface CreditsAware {
  sessionRunsOnCredits(sessionId: string): Promise<boolean>;
}

/** Whether this runtime can say whether one of its sessions runs on credits. */
function isCreditsAware(runtime: unknown): runtime is CreditsAware {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as CreditsAware).sessionRunsOnCredits === 'function'
  );
}

/** Whether this runtime can say which account a session launches on. */
function isLaunchAccountAware(runtime: unknown): runtime is LaunchAccountAware {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as LaunchAccountAware).checkLaunchAccount === 'function'
  );
}

/**
 * The folder a session's account ladder is read in: the agent folder the
 * session is bound to, else the caller's working directory when it lies inside
 * the boundary, else the server's default.
 */
async function sessionProjectDir(sessionId: string, cwd: string | undefined): Promise<string> {
  const bound = await runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null);
  if (bound) return bound;
  if (cwd) {
    try {
      return await validateBoundary(cwd);
    } catch {
      // A folder outside the boundary says nothing about this session.
    }
  }
  return DEFAULT_CWD;
}

/**
 * Whether a session runs on DorkOS credits, or will when it starts.
 *
 * The same answer its launch reaches: the account disk has already bound it
 * to; else the person's pick for this session (`accountHint`); else the
 * ladder (the folder's agent, then the machine default). A runtime that
 * declares no credits protocol never runs on credits. One that does but has
 * no account ladder answers for its own sessions (`sessionRunsOnCredits`),
 * else by its recorded default.
 *
 * Never throws: a ladder that cannot be read answers `false`, and the model
 * gate then judges against the runtime's own catalog, as it did before
 * credits existed. The launch itself stays the authority on who pays.
 *
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param opts - The person's pick for this session, and the folder it runs in.
 * @param opts.accountHint - The account the person picked before the first message.
 * @param opts.cwd - The caller's working directory, for a session not yet bound to one.
 */
export async function sessionRunsOnCredits(
  runtime: AgentRuntime,
  sessionId: string,
  opts: { accountHint?: string | undefined; cwd?: string | undefined } = {}
): Promise<boolean> {
  if (runtime.getCapabilities().credits === undefined) return false;
  if (!isLaunchAccountAware(runtime)) {
    // A runtime with no account ladder answers for its own sessions (Codex: the
    // home a thread's rollout lives in, else its recorded default; OpenCode:
    // its one sidecar's mode); one that cannot, by its recorded default.
    if (opts.accountHint === CREDITS_ACCOUNT_ID) return true;
    try {
      return isCreditsAware(runtime)
        ? await runtime.sessionRunsOnCredits(sessionId)
        : creditsIsDefaultFor(runtime.type);
    } catch {
      return false;
    }
  }
  try {
    const projectDir = await sessionProjectDir(sessionId, opts.cwd);
    const launch = await runtime.checkLaunchAccount(sessionId, projectDir, opts.accountHint);
    return launch.ok && launch.accountId === CREDITS_ACCOUNT_ID;
  } catch (err) {
    logger.debug('[model gate] could not read the session account', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Whether an agent's sessions run on DorkOS credits, as far as its own
 * settings go: its file names credits and a person allowed it (or is naming
 * them in this very request), or it names no account and credits are the
 * machine default for its runtime. A runtime that declares no credits
 * protocol never does.
 *
 * @param runtime - The agent's runtime.
 * @param agent - The agent's id and the account its settings will name.
 * @param accountNamedNow - Whether the request being judged names the account
 *   itself, which only a person can do (the route records their consent).
 */
export function agentRunsOnCredits(
  runtime: Pick<AgentRuntime, 'getCapabilities' | 'type'>,
  agent: { id: string | undefined; account: string | null | undefined },
  accountNamedNow: boolean
): boolean {
  if (runtime.getCapabilities().credits === undefined) return false;
  if (agent.account === CREDITS_ACCOUNT_ID) {
    return accountNamedNow || (agent.id !== undefined && creditsAllowedForAgent(agent.id));
  }
  return agent.account == null && creditsIsDefaultFor(runtime.type);
}

/**
 * The id a runtime's model alias expands to (`sonnet` → its wire id), or
 * `undefined` when the runtime does not say or the value is already an id.
 * Read from the runtime's own catalog, which is cached; a catalog that cannot
 * be read answers `undefined`.
 *
 * @param runtime - The runtime the model belongs to.
 * @param model - The model value as stored.
 */
export async function resolvedModelFor(
  runtime: Pick<AgentRuntime, 'getSupportedModels'>,
  model: string
): Promise<string | undefined> {
  try {
    const rows = await runtime.getSupportedModels();
    return rows.find((row) => row.value === model)?.resolvedModel;
  } catch {
    return undefined;
  }
}

/**
 * The sentence to refuse a model on credits with, or `null`: credits serve it
 * (under its own id or the one it expands to), or the service says nothing
 * about protocols and nothing is judged.
 *
 * @param runtime - The runtime the work runs on.
 * @param model - The model the write names.
 */
export async function creditsModelRefusal(
  runtime: Pick<AgentRuntime, 'getCapabilities' | 'getSupportedModels'>,
  model: string
): Promise<string | null> {
  const verdict = await judgeCreditsModel(
    runtime.getCapabilities(),
    model,
    await resolvedModelFor(runtime, model)
  );
  return verdict.judged ? verdict.refusal : null;
}

/**
 * The sentence to refuse an agent's model with when the agent runs on credits
 * and credits do not serve it, else `null`. One rule for every write that sets
 * an agent's model: the operator's `PATCH /api/mesh/agents/:id`, the agent's
 * own `PATCH /api/agents/current` and `update_agent`, and agent creation.
 *
 * @param opts - The agent and the settings it will have after the write.
 * @param opts.agentId - The agent's id, or `undefined` for one not created yet.
 * @param opts.runtime - The runtime it will run on (absent: the default runtime).
 * @param opts.account - The account its settings will name.
 * @param opts.model - The model the write names.
 * @param opts.accountNamedNow - Whether this write names the account itself
 *   (only a person can, and the route records their consent).
 */
export async function creditsAgentModelRefusal(opts: {
  agentId: string | undefined;
  runtime: string | null | undefined;
  account: string | null | undefined;
  model: string;
  accountNamedNow: boolean;
}): Promise<string | null> {
  const type = opts.runtime || runtimeRegistry.getDefaultType();
  if (!runtimeRegistry.has(type)) return null;
  const runtime = runtimeRegistry.get(type);
  const onCredits = agentRunsOnCredits(
    runtime,
    { id: opts.agentId, account: opts.account },
    opts.accountNamedNow
  );
  return onCredits ? creditsModelRefusal(runtime, opts.model) : null;
}

/**
 * {@link creditsAgentModelRefusal} for one agent PATCH: judged only when the
 * patch names a model, against the runtime and account the agent will have
 * after it (the patch's own, else the ones on file).
 *
 * @param agentId - The agent being updated.
 * @param fields - The fields the patch sets.
 * @param accountNamedNow - Whether the patch names the account itself.
 * @param existing - The agent as it stands, if registered.
 */
export async function creditsAgentPatchRefusal(
  agentId: string,
  fields: { model?: string | null; runtime?: string | null; account?: string | null },
  accountNamedNow: boolean,
  existing: { runtime?: string | null; account?: string | null } | undefined
): Promise<string | null> {
  if (typeof fields.model !== 'string') return null;
  return creditsAgentModelRefusal({
    agentId,
    runtime: fields.runtime ?? existing?.runtime,
    account: accountNamedNow ? (fields.account ?? null) : existing?.account,
    model: fields.model,
    accountNamedNow,
  });
}
