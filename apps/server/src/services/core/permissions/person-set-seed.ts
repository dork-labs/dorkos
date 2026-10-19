/**
 * The one-time seed of the person-set record (DOR-3107).
 *
 * The record starts empty on an upgraded install, and an agent may already
 * have written Full autonomy into its own settings file before it existed. So
 * the file is never copied as it stands. Each agent's floor is, key by key,
 * the STRICTER of its file and the last value a person set for that key
 * according to the permission history; a key no person ever set stands at the
 * default. An agent that raised itself before the upgrade comes out at the
 * person's value.
 *
 * Three writers the history never trusts: `outside` (the file changed without
 * DorkOS), `upgrade` (a boot fold of retired fields, which an agent can write
 * into its own file) and `agent` (an agent's change with no card: before
 * DOR-3107 such a change could loosen its own settings, and a past self-raise
 * must never become its floor). What counts is a person's: their own writes
 * and the cards they approved.
 *
 * @module services/core/permissions/person-set-seed
 */
import {
  type AgentPermissions,
  type PermissionAttribution,
  type PermissionChangedMetadata,
} from '@dorkos/shared/permissions';
import { stricterPermissions, type NarrowingContext } from './arrival-narrowing.js';
import type { PersonSetPermissions } from './person-set-permissions.js';

/** The history writers whose changes do not count as a person's. */
const UNTRUSTED: ReadonlySet<PermissionAttribution> = new Set(['outside', 'upgrade', 'agent']);

/** One recorded permission change, as the seed reads it. */
interface HistoryItem {
  metadata: Record<string, unknown> | null;
}

/** What the seed reads. */
export interface PersonSetSeedDeps {
  /** The record to seed. */
  personSet: Pick<PersonSetPermissions, 'isSeeded' | 'seed'>;
  /** Every registered agent: id and folder. */
  agents: () => readonly { id: string; projectPath: string }[];
  /** An agent's settings file as it stands, unnarrowed. */
  readFile: (agentPath: string) => Promise<AgentPermissions | undefined>;
  /** Every `permission.changed` event, oldest first. */
  history: () => Promise<readonly HistoryItem[]>;
  /** The defaults and the action catalog. */
  context: () => NarrowingContext;
}

/**
 * Replay the trusted history into each agent's last person-set settings.
 *
 * @param items - `permission.changed` events, oldest first.
 */
export function personSetFromHistory(items: readonly HistoryItem[]): Map<string, AgentPermissions> {
  const byAgent = new Map<string, AgentPermissions>();
  for (const item of items) {
    const meta = item.metadata as Partial<PermissionChangedMetadata> | null;
    if (!meta?.changes || !meta.attribution || UNTRUSTED.has(meta.attribution)) continue;
    for (const change of meta.changes) {
      if (change.target.kind !== 'agent') continue;
      const agentId = change.target.agentId;
      const next: AgentPermissions = { ...byAgent.get(agentId) };
      const key = change.key;
      if (key.kind === 'files') {
        if (change.after)
          next.filesAndCommands = change.after as AgentPermissions['filesAndCommands'];
        else delete next.filesAndCommands;
      } else if (key.kind === 'area') {
        const areas = { ...next.areas };
        if (change.after)
          areas[key.area] = change.after as NonNullable<AgentPermissions['areas']>[string];
        else delete areas[key.area];
        next.areas = areas;
      } else if (key.kind === 'action') {
        const actions = { ...next.actions };
        if (change.after)
          actions[key.action] = change.after as NonNullable<AgentPermissions['actions']>[string];
        else delete actions[key.action];
        next.actions = actions;
      }
      byAgent.set(agentId, next);
    }
  }
  return byAgent;
}

/**
 * Seed the person-set record once, if it never has been.
 *
 * @param deps - The record, the agents, their files, the history, the defaults.
 */
export async function seedPersonSetPermissions(deps: PersonSetSeedDeps): Promise<void> {
  if (deps.personSet.isSeeded()) return;
  const lastSet = personSetFromHistory(await deps.history());
  const context = deps.context();
  const floors = new Map<string, AgentPermissions>();
  for (const agent of deps.agents()) {
    let file: AgentPermissions | undefined;
    try {
      file = await deps.readFile(agent.projectPath);
    } catch {
      // An unreadable file contributes nothing; the person's value or the
      // default stands.
      file = undefined;
    }
    const floor = stricterPermissions(file, lastSet.get(agent.id), context);
    if (floor) floors.set(agent.id, floor);
  }
  deps.personSet.seed(floors);
}
