/**
 * One roster of every identity on this install (ADR 260806-222535, spec
 * `identity-consistency` §W2.2).
 *
 * A **read-only projection** over two registries that already exist: `authors`
 * for people, the mesh cache for agents. It mints nothing, writes nothing and
 * creates no row — every id it returns already existed. That is the decision,
 * not an implementation detail: a `members` table or a person entity would fork
 * a third identity model beside two the repo has already converged on.
 *
 * It lives in `services/identity/` rather than under `rooms/` or `mesh/`
 * because it reads both and belongs to neither — this domain answers "who is on
 * this install, and what do they look like".
 *
 * Degradation copies `aggregate-session-list.ts` exactly (ADR-0310): each
 * source is read under its own budget, a failure contributes a `warnings[]`
 * entry and zero rows, and the other sources still return. A source that is
 * entirely unreadable is a degraded roster, never a 500 — the person reading
 * the page is on it, so the roster is never empty for the reason that matters.
 *
 * **Every read is inside that envelope, not just the two registries.** The
 * account lookup, the two config reads and the owner predicate were once
 * outside it, and each was a 500 waiting for a corrupt `config.json` or a
 * locked database — a roster that cannot say your name should still be able to
 * list your agents. So a failure in any of them costs exactly what it knows and
 * nothing more: the roster degrades the operator's NAME, never the roster.
 *
 * **One thing this module cannot tell you: whether an agent is mid-turn.** The
 * mesh's `active` health status means "seen within the last hour"
 * (`ACTIVE_THRESHOLD_MINUTES = 60`), which is why the payload says
 * `recentlyActive` and not `working`. A true live-turn signal exists — the room
 * claim map, `services/rooms/room-claims.ts` (`claimsWorkingIn`) — and can join
 * as a third source when a surface needs it. The client task will want this
 * pointer.
 *
 * @module server/services/identity/aggregate-team
 */
import type {
  TeamAgentFacts,
  TeamMember,
  TeamRosterResponse,
  TeamSourceWarning,
} from '@dorkos/shared/team-schemas';
import type { AgentHealthStatus, AgentRuntime } from '@dorkos/shared/mesh-schemas';
import { logger } from '../../lib/logger.js';
import { authorOrigin, isOwnerRecord, type AuthorRecord } from '../rooms/author-registry.js';
import {
  resolveOperatorProfile,
  type OperatorAccount,
  type OperatorProfile,
} from './operator-profile.js';

/**
 * Per-source budget, mirroring `LIST_SESSIONS_TIMEOUT_MS`.
 *
 * Both registries behind this endpoint are synchronous `better-sqlite3` reads
 * today, so nothing here can exceed it yet. The budget is still applied rather
 * than assumed away: the sources are typed as possibly-async precisely because
 * the next one (a remote community backend, §W2.6) will be, and a source added
 * later must not be able to stall the whole roster by being slow.
 */
export const TEAM_SOURCE_TIMEOUT_MS = 2_000;

/** The `authors` source, named as it appears in a warning. */
export const AUTHORS_SOURCE = 'authors';

/** The mesh source, named as it appears in a warning. */
export const AGENTS_SOURCE = 'agents';

/**
 * The owner-account read, named as it appears in a warning.
 *
 * Its own source rather than folded into `authors` because it fails for its own
 * reasons and costs its own thing: the `authors` table can be perfectly readable
 * while the account lookup is not, and what you lose then is your NAME on your
 * own row — not the roster.
 */
export const OPERATOR_SOURCE = 'operator';

/**
 * The `~/.dork/config.json` reads, named as they appear in a warning.
 *
 * `config.profile.displayName` and `config.agents.defaultAgent` come from one
 * file through one manager, so one name covers both: a corrupt or locked config
 * loses the preferred name and the default-agent mark, and nothing else.
 */
export const CONFIG_SOURCE = 'config';

/**
 * One agent as the roster reads it — structurally what `meshCore.listWithHealth()`
 * returns.
 *
 * Declared here rather than imported from `@dorkos/mesh` so the aggregation
 * depends on the shape it uses and not on the mesh package, which is the same
 * reason it is injected as a function below.
 */
export interface TeamAgentSource {
  id: string;
  name: string;
  displayName?: string;
  runtime: AgentRuntime;
  model?: string;
  icon?: string;
  color?: string;
  /**
   * The namespace used for cross-agent messaging permissions.
   *
   * **Nothing production serves fills this**, and the field is here anyway.
   * `meshCore.listWithHealth()` runs every entry through `toManifest()`
   * (`packages/mesh/src/mesh-agent-management.ts`), which strips `projectPath`,
   * `namespace` and `scanRoot` — they are internal registry fields, and a room is
   * a shared surface. Optional so a source entitled to carry it can, without this
   * module growing a second read of the mesh to fetch it. A test runs a real
   * registry entry through the real strip so this comment cannot go stale
   * silently.
   */
  namespace?: string;
  /** Stripped by the same `toManifest()` call, for the same reason as `namespace`. */
  projectPath?: string;
  isSystem?: boolean;
  registeredAt: string;
  healthStatus: AgentHealthStatus;
}

/**
 * Where the roster's rows come from. Every one of them is a read, and every one
 * of them may fail without failing the request.
 */
export interface TeamRosterSources {
  /** Active human authors — `authors` where `retired_at IS NULL` and `kind = 'human'`. */
  listPeople: () => AuthorRecord[] | Promise<AuthorRecord[]>;
  /** The fleet with health — `meshCore.listWithHealth()`, no new mesh query. */
  listAgents: () => TeamAgentSource[] | Promise<TeamAgentSource[]>;
  /**
   * The account that owns this install, with its address, or `null` when nobody
   * has registered.
   *
   * Read ONCE per roster and used for two things — the operator's name, and
   * which author row is theirs. There is deliberately no injected "is this the
   * owner" predicate beside it: the answer is
   * {@link isOwnerRecord}, a pure comparison against a row this roster already
   * holds, so asking the registry again would be one query per person against
   * the table the list just came from.
   */
  account: () => OperatorAccount | null;
  /** `config.profile.displayName` — "what the user likes to be called". */
  configDisplayName: () => string | null;
  /** `config.agents.defaultAgent`, or `null` when nothing is configured. */
  defaultAgentName: () => string | null;
  /** Per-source budget; defaults to {@link TEAM_SOURCE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`reading ${source} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/** Read one source, degrading a failure into a warning and zero rows. */
async function readSource<T>(
  source: string,
  read: () => T[] | Promise<T[]>,
  timeoutMs: number
): Promise<{ items: T[]; warning?: TeamSourceWarning }> {
  try {
    // `Promise.resolve().then(read)` rather than `read()` so a source that
    // throws SYNCHRONOUSLY — which both of today's `better-sqlite3` sources do —
    // rejects the promise instead of escaping this try in a later refactor.
    const items = await withTimeout(Promise.resolve().then(read), timeoutMs, source);
    return { items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[aggregateTeamRoster] identity source degraded', { source, error: message });
    return { items: [], warning: { source, message } };
  }
}

/**
 * Read one value that decorates the roster, degrading a failure to `fallback`.
 *
 * The scalar counterpart of {@link readSource}, and the reason the five reads
 * that are not registries can no longer 500 the request. No timeout: these are
 * an in-memory config object and one indexed row, and a budget on them would be
 * ceremony.
 */
function readValue<T>(
  source: string,
  read: () => T,
  fallback: T,
  warnings: TeamSourceWarning[]
): T {
  try {
    return read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[aggregateTeamRoster] identity source degraded', { source, error: message });
    warnings.push({ source, message });
    return fallback;
  }
}

/** Project one active human author onto a roster row. */
function personRow(
  record: AuthorRecord,
  isSelf: boolean,
  operatorName: string,
  operatorEmail: string | undefined
): TeamMember {
  return {
    id: record.id,
    kind: 'human',
    // The divergence `operator-profile.ts` exists for: the operator's own row
    // carries their real name, everyone else carries the name their author row
    // was minted under.
    displayName: isSelf ? operatorName : record.displayName,
    // `authors` has no handle column until DOR-676 lands. `null` is the honest
    // answer and already means "cannot be addressed" everywhere handles render.
    handle: null,
    ...(record.emoji ? { emoji: record.emoji } : {}),
    ...(record.color ? { color: record.color } : {}),
    isSelf,
    // Nothing owns a person.
    ownerId: null,
    origin: authorOrigin(record.naturalKey),
    person: {
      // No backend on this install declares roles yet.
      role: null,
      ...(isSelf && operatorEmail ? { email: operatorEmail } : {}),
    },
  };
}

/** Project one registered agent onto a roster row. */
function agentRow(
  agent: TeamAgentSource,
  operatorId: string | null,
  defaultAgentName: string | null
): TeamMember {
  const isSystem = agent.isSystem === true;
  const facts: TeamAgentFacts = {
    manifestId: agent.id,
    runtime: agent.runtime,
    ...(agent.model ? { model: agent.model } : {}),
    healthStatus: agent.healthStatus,
    // `active` is the mesh's word for "seen within the last hour"
    // (ACTIVE_THRESHOLD_MINUTES = 60), which is the only liveness this endpoint
    // can read without a second query — hence the field's name. It is NOT
    // "mid-turn"; see the module doc for where that signal actually lives.
    recentlyActive: agent.healthStatus === 'active',
    ...(agent.namespace ? { namespace: agent.namespace } : {}),
    ...(agent.projectPath ? { projectPath: agent.projectPath } : {}),
    isDefault: defaultAgentName !== null && agent.name === defaultAgentName,
    isSystem,
    registeredAt: agent.registeredAt,
  };
  return {
    id: agent.id,
    kind: 'agent',
    displayName: agent.displayName ?? agent.name,
    handle: null,
    ...(agent.icon ? { emoji: agent.icon } : {}),
    ...(agent.color ? { color: agent.color } : {}),
    isSelf: false,
    // A system agent belongs to the install, not to a person. Every other agent
    // on this machine belongs to the one operator — and when the operator's own
    // row could not be read, there is no id in THIS roster's space to point at,
    // so a dangling reference is refused in favour of `null`.
    ownerId: isSystem ? null : operatorId,
    origin: 'local',
    agent: facts,
  };
}

/**
 * Build the roster.
 *
 * Order is the contract the page renders against: the operator first, then
 * everyone else in the order `authors` returns them, then the agents in the
 * order the mesh returns them. Nothing re-sorts the fleet here — the page's
 * attention order is a client concern and a server-side sort would fight it.
 *
 * @param sources - The reads this roster is made of.
 */
export async function aggregateTeamRoster(sources: TeamRosterSources): Promise<TeamRosterResponse> {
  const timeoutMs = sources.timeoutMs ?? TEAM_SOURCE_TIMEOUT_MS;

  const [people, agents] = await Promise.all([
    readSource(AUTHORS_SOURCE, () => sources.listPeople(), timeoutMs),
    readSource(AGENTS_SOURCE, () => sources.listAgents(), timeoutMs),
  ]);

  const warnings: TeamSourceWarning[] = [];
  if (people.warning) warnings.push(people.warning);
  if (agents.warning) warnings.push(agents.warning);

  // Every read below is degradable. Losing the account costs the operator's
  // name and their `isSelf` mark; losing the config costs the preferred name
  // and the default-agent mark. Neither costs a single row.
  const account = readValue(OPERATOR_SOURCE, sources.account, null, warnings);
  const configDisplayName = readValue(CONFIG_SOURCE, sources.configDisplayName, null, warnings);
  const defaultAgentName = readValue(CONFIG_SOURCE, sources.defaultAgentName, null, warnings);

  // A pure comparison against rows already in hand — see `TeamRosterSources.account`
  // for why this is not an injected predicate.
  const self = people.items.find((record) => isOwnerRecord(record, account?.id ?? null)) ?? null;
  const operator: OperatorProfile = resolveOperatorProfile(
    { account: () => account, configDisplayName: () => configDisplayName },
    self?.displayName ?? null
  );

  const personRows = people.items.map((record) =>
    personRow(record, record.id === self?.id, operator.displayName, operator.email)
  );
  // The operator first — and this really does move a row: `listActive` orders by
  // `created_at`, and a bridged group seen before login was enabled leaves an
  // external person minted BEFORE the owner. `sort` rather than a partition
  // because it is one row moving and the rest keep the order `authors` gave them.
  personRows.sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  const agentRows = agents.items.map((agent) =>
    agentRow(agent, self?.id ?? null, defaultAgentName)
  );

  const members = [...personRows, ...agentRows];
  // Omitted entirely on a clean read, never `[]` — the ADR-0310 rule, so a
  // client can treat the key's presence as the degradation signal.
  return warnings.length > 0 ? { members, warnings } : { members };
}
