/**
 * What model a relay-triggered turn runs on.
 *
 * The relay adapter lives in `@dorkos/relay` and cannot see a manifest, the
 * user's config or the settings table, so it asks for this through a seam
 * ({@link ExecutionSettingsResolver}) and the server answers. Before that seam
 * existed nothing on the path answered at all: an agent pinned to Opus replied
 * to a colleague on whatever the server happened to default to, while the very
 * same agent addressed in a room or from the cockpit answered on Opus
 * (DOR-1344).
 *
 * The answer is deliberately the SAME one a room turn gets — both go through
 * {@link resolveUnattendedSessionDefaults} — because "which model is this agent"
 * must not depend on who is asking it.
 *
 * ## Stored settings win PER KEY, not per row
 *
 * A setting a person chose for this conversation wins: "applies to new
 * conversations, running ones keep their settings." Everywhere else that rule
 * is kept by handing the runtime nothing and letting it hydrate the row itself,
 * which is what `ensureForMessage` does. The relay cannot do that — it calls
 * `ensureSession` first, which creates the session record before any hydration
 * would run — so the row is read here and merged in. Same promise, one step
 * earlier.
 *
 * **Key by key, because a row is not an answer to every question.** Moving the
 * trust dial writes a row that names a permission mode and NOTHING else, and a
 * row-shaped rule would read that as "this conversation has settings" and skip
 * the ladder entirely — so an agent would lose its model the moment somebody
 * touched its permissions, permanently, for that conversation. The other
 * surfaces do not have that hazard because `persistSessionRuntime` fills the
 * row's NULL columns from the same ladder (`fillNullsWith(seedForNewRow(…))`).
 *
 * A chat-originated session now takes that write too — the binding subsystem
 * records which runtime owns it the moment it is created (DOR-1614) — but a
 * relay turn can still reach a session that has no row at all: a direct
 * agent-to-agent `relay_send` addresses a mesh agent, not a session anybody
 * created here. Merging per key is what makes both kinds yield what the other
 * surfaces already yield.
 *
 * The permission mode is in neither half. The relay resolves its own from the
 * binding that carried the message, and treats an absent one as prompting
 * rather than as consent (DOR-604); an answer from here would be a second
 * answer to a settled question.
 *
 * @module services/relay/turn-execution-settings
 */
import type { ExecutionSettingsResolver, TurnExecutionSettings } from '@dorkos/relay';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';
import { logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { checkAccountLaunch } from '../core/usage/account-ranking.js';
import { getAccountUsageStore } from '../core/usage/current-usage-store.js';
import { resolveAccountRef } from '../core/usage/runtime-accounts.js';
import { resolveUnattendedSessionDefaults } from '../session/index.js';

/**
 * Build the resolver the built-in relay adapter asks before every turn.
 *
 * The runtime arrives PER CALL rather than being fixed when the resolver is
 * built (DOR-1614). It used to be the adapter's own boot runtime, which was the
 * only honest answer while the relay drove exactly one; now the adapter resolves
 * a runtime per message and asks about that one. The distinction is not
 * cosmetic: every tier below the session row is a per-runtime answer — which
 * `runtimes.*` section holds the defaults, whether an effort applies at all, and
 * which namespace a model id is read in — so a resolver keyed by the wrong
 * runtime hands a Codex turn a Claude model alias.
 *
 * A manifest naming a runtime this build did not register is still resolved
 * onto whatever runtime the turn is actually running on, and its model dropped
 * rather than handed to another provider's namespace (see
 * `resolveSessionDefaults`).
 *
 * A `requestedAccount` (the payload's `account`, asked only for a new
 * conversation) comes back as `accountHint` only when the account advisor
 * allows it; see {@link allowedRelayAccount}.
 *
 * @returns A resolver that never throws — a settings problem is a reason to run
 *   the turn on the runtime's own default, never a reason to drop a message.
 */
export function createTurnExecutionSettingsResolver(): ExecutionSettingsResolver {
  return async ({ sessionId, runtimeType, agentDirectory, requestedAccount }) => {
    const stored = await readStoredSettings(sessionId);
    // `has` first, because `get` THROWS on an unregistered type and this
    // resolver promises never to. It could not happen while the runtime was
    // fixed at boot; it can now that it arrives per call, and a runtime nothing
    // declares is the same "no preference" every other absent tier is.
    const declared = runtimeRegistry.has(runtimeType)
      ? runtimeRegistry.get(runtimeType).getCapabilities().settings
      : undefined;
    const ladder = await resolveUnattendedSessionDefaults({
      runtimeType,
      ...(agentDirectory ? { agentPath: agentDirectory } : {}),
      ...(declared ? { declared } : {}),
    });
    // Picked out by name rather than spread, in both halves: `SessionSettings`
    // also admits a permission mode (the attended callers ask the ladder for
    // one, and a stored row usually holds one), and neither may travel back to
    // the relay. `fastMode` has no tier below the row — no manifest field and no
    // server default name it — so the row is the only place it can come from.
    const model = stored.model ?? ladder.model;
    const effort = stored.effort ?? ladder.effort;
    const accountHint =
      requestedAccount === undefined
        ? undefined
        : await allowedRelayAccount(requestedAccount, runtimeType, agentDirectory, sessionId);
    return {
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(stored.fastMode !== undefined && { fastMode: stored.fastMode }),
      ...(accountHint !== undefined && { accountHint }),
    };
  };
}

/**
 * The account a relay message may launch its new conversation on: the id it
 * named, when that id is registered for the turn's runtime AND the account
 * advisor allows the pick (spec `claude-account-fleet` D6, DOR-2384).
 *
 * **Who may set it.** Any sender can put `account` in a payload: an agent's
 * `relay_send`, an external MCP caller, a chat bridge. None of them is trusted
 * to spend on an account by saying so. Every request is checked as a `relay`
 * caller, which needs a registered advisor, so with no advisor (Flow not set
 * up) no relay message can move a conversation off the default ladder at all.
 * A schedule's own account travels as `accountHint` directly and never comes
 * through here: it is the operator's approved choice.
 *
 * Every refusal is logged at info and answers `undefined`, so the turn still
 * runs on the account it would have used anyway. It never throws.
 *
 * @param requested - The id the payload named.
 * @param runtimeType - The runtime the turn runs on.
 * @param agentDirectory - The addressed agent's directory, the launch's `cwd`.
 * @param sessionId - The session key, for the log line.
 */
async function allowedRelayAccount(
  requested: string,
  runtimeType: string,
  agentDirectory: string | undefined,
  sessionId: string
): Promise<string | undefined> {
  const refuse = (reason: string): undefined => {
    logger.info('[relay] running without the account the message named', {
      sessionId,
      account: requested,
      runtime: runtimeType,
      reason,
    });
    return undefined;
  };
  const store = getAccountUsageStore();
  const registered =
    store && isLedgerRuntime(runtimeType)
      ? resolveAccountRef(store.listAccounts(runtimeType), runtimeType, requested)
      : null;
  if (!registered) return refuse('not a registered account for this runtime');
  try {
    const decision = await checkAccountLaunch({
      accountId: registered.id,
      cwd: agentDirectory ?? '',
      runtime: runtimeType,
      caller: 'relay',
    });
    return decision.allowed ? registered.id : refuse(decision.reason);
  } catch (err) {
    return refuse(`the account check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isLedgerRuntime(runtime: string): runtime is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * What a person has already chosen for this conversation — an empty object when
 * they have chosen nothing, which a session with no row and a row that names
 * only a permission mode both are, and both truthfully.
 *
 * Tolerant of a failing read on purpose. A locked database here means the
 * question "what has this conversation got?" is unanswerable for a moment, and
 * the honest fallback is the ladder every new session starts on — not a refused
 * turn.
 *
 * @param sessionId - The key the relay turn runs under.
 */
async function readStoredSettings(sessionId: string): Promise<TurnExecutionSettings> {
  try {
    const stored = await runtimeRegistry.getSessionSettings(sessionId);
    if (!stored) return {};
    return {
      ...(stored.model !== undefined && { model: stored.model }),
      ...(stored.effort !== undefined && { effort: stored.effort }),
      ...(stored.fastMode !== undefined && { fastMode: stored.fastMode }),
    };
  } catch (err) {
    logger.warn('[relay] could not read the stored settings for a session', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
