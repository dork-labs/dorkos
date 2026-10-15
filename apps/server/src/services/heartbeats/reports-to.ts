/**
 * Who an agent reports to (spec `heartbeats` §4, canon P4 and §9.2).
 *
 * Every agent has a manager: the one its `reportsTo` names, else whoever
 * created it, else the owner. The chain above it always ends at a person —
 * writes that would loop are refused ({@link ReportsToChain.wouldCreateCycle}),
 * and because a hand-edited `agent.json` can still make a loop, the walk itself
 * stops at the owner the first time it sees an id twice and records that once.
 *
 * An account id names either a person (the owner's account id, from the audit
 * log's resolver) or an agent (its mesh ULID). An id that names neither — an
 * agent since removed, a creator this install never knew — is skipped, never
 * followed.
 *
 * @module services/heartbeats/reports-to
 */
import type { MeshCore } from '@dorkos/mesh';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import { currentAuditActor } from '../audit/audit-context.js';
import { auditTrail, recordAudit } from '../audit/audit-trail.js';

/** The fields of an agent the chain is walked through. */
export interface ReportsToAgent {
  /** Its mesh ULID. */
  id: string;
  /** Display name, for the audit row a loop leaves. */
  name?: string;
  /** Who it reports to, when set. */
  reportsTo?: string | null;
  /** The account that created it, when known. */
  createdBy?: string | null;
}

/** What the chain needs to know about this install. */
export interface ReportsToDeps {
  /** An agent by mesh id, or `undefined` when no such agent exists now. */
  getAgent(id: string): ReportsToAgent | undefined;
  /** The owner's account id: where every chain ends when nothing else answers. */
  ownerAccountId(): string;
  /**
   * The canonical account id of the person `id` names, or `null` when it names
   * no person this install knows. The owner is the only person today; more
   * people arrive with their own accounts (DOR-2743).
   */
  personAccountId(id: string): string | null;
}

/** Why a manager is the manager. */
export type ManagerSource = 'reportsTo' | 'createdBy' | 'owner';

/** One step up the chain. */
export interface ManagerRef {
  /** An agent or a person. */
  kind: 'agent' | 'person';
  /** The manager's account id: a mesh ULID or a person's account id. */
  accountId: string;
  /** Which rule chose it. */
  source: ManagerSource;
}

/** The account id the owner is known by before the audit trail starts (tests, scripts). */
export const OWNER_FALLBACK_ACCOUNT_ID = 'owner';

/**
 * Chains a loop has already been recorded for, process-wide, so a walk that
 * runs on every beat records a hand-made loop once rather than every time.
 * Keyed by the loop's members, sorted, so every agent on it shares the one row.
 */
const recordedCycles = new Set<string>();

/** Forget which loops were recorded. For tests. */
export function resetRecordedChainCycles(): void {
  recordedCycles.clear();
}

/** Walks the reports-to chain over one view of the agents. */
export class ReportsToChain {
  constructor(private readonly deps: ReportsToDeps) {}

  /**
   * The owner, as a manager.
   *
   * @param source - Which rule fell through to the owner.
   */
  private owner(source: ManagerSource = 'owner'): ManagerRef {
    return { kind: 'person', accountId: this.deps.ownerAccountId(), source };
  }

  /**
   * What an account id names right now, or `null` when it names nobody.
   *
   * @param id - The account id to look up.
   * @param source - Which rule offered it.
   */
  private lookup(id: string | null | undefined, source: ManagerSource): ManagerRef | null {
    if (!id) return null;
    if (this.deps.getAgent(id)) return { kind: 'agent', accountId: id, source };
    const person = this.deps.personAccountId(id);
    return person ? { kind: 'person', accountId: person, source } : null;
  }

  /**
   * Whether an account id names an agent or person that exists now — what a
   * write surface checks before storing it as somebody's manager.
   *
   * @param id - The account id to check.
   */
  names(id: string): boolean {
    return this.lookup(id, 'reportsTo') !== null;
  }

  /**
   * The id to STORE for a manager: an agent's mesh id as given, and for a
   * person their canonical account id — so a write naming the owner by an
   * alias (`owner`, `install:<id>`) stores the one id the owner is known by.
   * An id that names nobody comes back unchanged.
   *
   * @param id - The account id a write named.
   */
  canonical(id: string): string {
    return this.lookup(id, 'reportsTo')?.accountId ?? id;
  }

  /**
   * Who `agentId` reports to: its `reportsTo`, else its creator, else the owner
   * (canon §9.2). A manager that no longer exists is skipped. An agent that
   * names itself is read as unset.
   *
   * The project lead and group lead rungs of canon §9.2 sit between the creator
   * and the owner and are skipped until projects and groups have leads
   * (DOR-2755).
   *
   * @param agentId - The agent's mesh id.
   */
  resolveManager(agentId: string): ManagerRef {
    const agent = this.deps.getAgent(agentId);
    if (!agent) return this.owner();
    const explicit = agent.reportsTo === agentId ? null : this.lookup(agent.reportsTo, 'reportsTo');
    if (explicit) return explicit;
    const creator = agent.createdBy === agentId ? null : this.lookup(agent.createdBy, 'createdBy');
    if (creator) return creator;
    // DOR-2755: the project lead, then the group lead, go here once they exist.
    return this.owner();
  }

  /**
   * The first person up the chain from `agentId` — whose hours the agent keeps
   * and who gets what it raises (spec §3.5, §9).
   *
   * Stops at the owner on the first repeated id, and records
   * `heartbeat.chain_cycle` the first time this process meets that loop.
   *
   * @param agentId - The agent's mesh id.
   */
  resolveChainPerson(agentId: string): ManagerRef {
    const seen: string[] = [agentId];
    let current = agentId;
    for (;;) {
      const manager = this.resolveManager(current);
      if (manager.kind === 'person') return manager;
      if (seen.includes(manager.accountId)) {
        this.recordCycle(agentId, seen.slice(seen.indexOf(manager.accountId)));
        return this.owner();
      }
      seen.push(manager.accountId);
      current = manager.accountId;
    }
  }

  /**
   * Whether making `newManagerId` the manager of `agentId` would close a loop.
   *
   * Walks up from the new manager through the chain as it resolves today
   * (reportsTo, then creator); reaching `agentId` means the write would make
   * the agent its own manager's manager. A person never closes a loop, and an
   * existing loop elsewhere that never reaches `agentId` is not this write's.
   *
   * @param agentId - The agent being changed.
   * @param newManagerId - The account id it would report to, or `null` to clear.
   */
  wouldCreateCycle(agentId: string, newManagerId: string | null): boolean {
    if (newManagerId === null) return false;
    if (newManagerId === agentId) return true;
    const seen = new Set<string>();
    let current: string = newManagerId;
    while (this.deps.getAgent(current) && !seen.has(current)) {
      seen.add(current);
      const manager = this.resolveManager(current);
      if (manager.kind === 'person') return false;
      if (manager.accountId === agentId) return true;
      current = manager.accountId;
    }
    return false;
  }

  /**
   * Record a hand-made loop once per process (spec §4.1).
   *
   * @param agentId - The agent whose walk met it.
   * @param members - The ids on the loop, in walk order.
   */
  private recordCycle(agentId: string, members: string[]): void {
    const key = [...members].sort().join(',');
    if (recordedCycles.has(key)) return;
    recordedCycles.add(key);
    const agent = this.deps.getAgent(agentId);
    recordAudit({
      action: 'heartbeat.chain_cycle',
      operation: 'access',
      target: { type: 'agent', id: agentId, ...(agent?.name ? { name: agent.name } : {}) },
      outcome: 'refused',
      reason: `Reports-to loop: ${members.join(' → ')}`,
      summary: 'Its reports-to chain loops, so it reports to the owner until that is fixed.',
      visibility: 'space',
    });
  }
}

/** The slice of {@link MeshCore} the server's chain reads. */
export type ReportsToMesh = Pick<MeshCore, 'get'>;

/**
 * The chain as the server sees it: agents from the mesh mirror, people from the
 * audit log's account-id resolver.
 *
 * The owner is known by two ids over an install's life — `install:<id>` until
 * an account exists, the account's id after — and an agent created before the
 * account carries the first. Both name the owner here, so that agent still
 * reports to them.
 *
 * @param mesh - Where agents are looked up.
 */
export function createReportsToChain(mesh: ReportsToMesh): ReportsToChain {
  return new ReportsToChain({
    getAgent: (id) => {
      const agent = mesh.get(id);
      return agent
        ? {
            id: agent.id,
            name: agent.displayName ?? agent.name,
            reportsTo: agent.reportsTo,
            createdBy: agent.createdBy,
          }
        : undefined;
    },
    ownerAccountId: () => auditTrail()?.accounts.owner().accountId ?? OWNER_FALLBACK_ACCOUNT_ID,
    personAccountId: (id) => {
      const trail = auditTrail();
      const owner = trail?.accounts.owner().accountId ?? OWNER_FALLBACK_ACCOUNT_ID;
      const ownerAliases = [owner, trail?.accounts.installAccountId(), OWNER_FALLBACK_ACCOUNT_ID];
      return ownerAliases.includes(id) ? owner : null;
    },
  });
}

/**
 * The account id that is creating something right now, for `createdBy`: the
 * person or agent the current audit scope names.
 *
 * `null` when nobody can be named — DorkOS acting on its own (startup seeding),
 * or a caller that presented a token nobody could resolve. An unresolved
 * agent's path hash is not a mesh id and names no one the chain could follow.
 */
export function currentCreatorAccountId(): string | null {
  return creatorFromActor(currentAuditActor()?.actor);
}

/**
 * `{ createdBy }` for a manifest being minted now, or nothing when nobody can
 * be named — so a manifest never carries a `createdBy: null` it was not given.
 */
export function creatorField(): { createdBy?: string } {
  const createdBy = currentCreatorAccountId();
  return createdBy ? { createdBy } : {};
}

/**
 * The `createdBy` value an actor stands for.
 *
 * @param actor - Who is acting.
 */
export function creatorFromActor(actor: AuditActor | undefined): string | null {
  if (!actor) return null;
  if (actor.kind === 'person') return actor.accountId;
  if (actor.kind === 'agent' && !actor.accountId.startsWith('unregistered:')) {
    return actor.accountId;
  }
  return null;
}
