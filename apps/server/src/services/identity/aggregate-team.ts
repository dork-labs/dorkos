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
import { authorOrigin, type AuthorRecord } from '../rooms/author-registry.js';
import { resolveOperatorProfile, type OperatorProfileSources } from './operator-profile.js';

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
  namespace?: string;
  /**
   * Absent from the mesh's health-enriched listing, which strips it per the
   * manifest contract. Optional here so a source entitled to carry it can,
   * without this module growing a second read of the mesh to fetch it.
   */
  projectPath?: string;
  isSystem?: boolean;
  registeredAt: string;
  healthStatus: AgentHealthStatus;
}

/** Where the roster's rows come from. Every one of them is a read. */
export interface TeamRosterSources extends OperatorProfileSources {
  /** Active human authors — `authors` where `retired_at IS NULL` and `kind = 'human'`. */
  listPeople: () => AuthorRecord[] | Promise<AuthorRecord[]>;
  /** The fleet with health — `meshCore.listWithHealth()`, no new mesh query. */
  listAgents: () => TeamAgentSource[] | Promise<TeamAgentSource[]>;
  /**
   * Whether an author id is this install's owner.
   *
   * `AuthorRegistry.isOwner`, which is already the predicate that replaced
   * `kind === 'human'` everywhere "is the operator" was meant. Asked rather
   * than derived here so the roster cannot disagree with the rooms domain about
   * who the operator is — and because the alternative, resolving the operator's
   * author through `bindOwner`/`localHuman`, would MINT a row from a read-only
   * endpoint.
   */
  isOwnerAuthor: (authorId: string) => boolean;
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
    // `active` is the mesh's own word for "seen in the last few minutes", which
    // is the only liveness this endpoint can read without a second query.
    working: agent.healthStatus === 'active',
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

  const self = people.items.find((record) => sources.isOwnerAuthor(record.id)) ?? null;
  const operator = resolveOperatorProfile(sources, self?.displayName ?? null);

  const personRows = people.items.map((record) =>
    personRow(record, record.id === self?.id, operator.displayName, operator.email)
  );
  // The operator first. `sort` rather than a partition because it is one row
  // moving and the rest keep the order `authors` gave them.
  personRows.sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  const defaultAgentName = sources.defaultAgentName();
  const agentRows = agents.items.map((agent) =>
    agentRow(agent, self?.id ?? null, defaultAgentName)
  );

  const members = [...personRows, ...agentRows];
  // Omitted entirely on a clean read, never `[]` — the ADR-0310 rule, so a
  // client can treat the key's presence as the degradation signal.
  return warnings.length > 0 ? { members, warnings } : { members };
}
