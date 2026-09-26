/**
 * Pure selection rules for the "who can use it" access card: which simple
 * level an agent holds today, which agents to show first, and the exact grant
 * replacements a card decision writes. Every level maps onto the same presets
 * the exact access editor offers ({@link revisionIdsForAccessLevel}), so the
 * card can never grant anything those presets would not.
 *
 * @module features/connections/lib/access-card-selection
 */
import type {
  ConnectorReconciliationCandidate,
  ConnectorReconciliationGrantSelection,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { revisionIdsForAccessLevel, selectionsFromPreview } from './reconciliation-selection';

/** The two levels the card offers. Exact per-action picks stay in the exact access editor. */
export type CardAccessLevel = 'read' | 'read-write';

/** What an agent holds today, read against the card's presets. */
export type HeldAccess = 'none' | CardAccessLevel | 'custom';

/** How many agents the page mode lists before "Show all". */
export const VISIBLE_AGENT_LIMIT = 5;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Classify one agent's current exact grant against the card's presets.
 *
 * @param candidates - The preview's complete operation snapshot.
 * @param granted - The agent's current operation revision ids.
 * @returns `'custom'` whenever the set is anything other than an exact preset.
 */
export function heldAccess(
  candidates: ConnectorReconciliationCandidate[],
  granted: readonly string[]
): HeldAccess {
  if (granted.length === 0) return 'none';
  if (sameIds(granted, revisionIdsForAccessLevel(candidates, 'read'))) return 'read';
  if (sameIds(granted, revisionIdsForAccessLevel(candidates, 'read-write'))) return 'read-write';
  return 'custom';
}

/**
 * The level a card should start on: the one every preset-holding agent already
 * shares, otherwise the safer Read.
 *
 * @param held - Current access of the agents the card is about.
 */
export function initialCardLevel(held: HeldAccess[]): CardAccessLevel {
  const presets = held.filter(
    (level): level is CardAccessLevel => level === 'read' || level === 'read-write'
  );
  return presets.length > 0 && presets.every((level) => level === 'read-write')
    ? 'read-write'
    : 'read';
}

/**
 * Order agents most relevant first: those that already have access, then the
 * caller's suggestions (in the order given), then system agents, then the
 * server's alphabetical order.
 *
 * @param preview - Snapshot whose agent list is ordered.
 * @param options - Relevance hints.
 * @param options.preferredAgentIds - Agents the caller knows are relevant right now.
 * @param options.systemAgentIds - Built-in agents, such as DorkBot.
 */
export function rankAgents(
  preview: ConnectorReconciliationPreview,
  {
    preferredAgentIds = [],
    systemAgentIds = [],
  }: { preferredAgentIds?: readonly string[]; systemAgentIds?: readonly string[] } = {}
): ConnectorReconciliationPreview['agents'] {
  const current = selectionsFromPreview(preview);
  const rank = (agentId: string): number => {
    if ((current[agentId] ?? []).length > 0) return 0;
    const preferred = preferredAgentIds.indexOf(agentId);
    if (preferred >= 0) return 1 + preferred / (preferredAgentIds.length + 1);
    if (systemAgentIds.includes(agentId)) return 2;
    return 3;
  };
  return preview.agents
    .map((agent, index) => ({ agent, index, rank: rank(agent.agentId) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ agent }) => agent);
}

/**
 * The exact replacement sets a card decision writes, limited to agents whose
 * set actually changes.
 *
 * - A picked agent that had no access gets the chosen level.
 * - A picked agent on a preset moves to the chosen level only once the person
 *   has touched the level switch, so opening the card and adding one agent
 *   never quietly changes anyone else.
 * - A picked agent with exact per-action access keeps it untouched: the card
 *   cannot express that set, so it never overwrites it.
 * - An agent that had access and is no longer picked loses it.
 *
 * @param preview - Server snapshot the decision is made against.
 * @param picked - Agents the person picked.
 * @param level - The chosen level.
 * @param levelTouched - Whether the person changed the level switch.
 */
export function cardGrantChanges(
  preview: ConnectorReconciliationPreview,
  picked: ReadonlySet<string>,
  level: CardAccessLevel,
  levelTouched: boolean
): ConnectorReconciliationGrantSelection[] {
  const current = selectionsFromPreview(preview);
  const target = revisionIdsForAccessLevel(preview.candidates, level);
  return preview.agents.flatMap((agent) => {
    const before = current[agent.agentId] ?? [];
    const held = heldAccess(preview.candidates, before);
    let after: string[];
    if (!picked.has(agent.agentId)) after = [];
    else if (held === 'none') after = target;
    else if (held === 'custom' || !levelTouched) after = before;
    else after = target;
    return sameIds(before, after) ? [] : [{ agentId: agent.agentId, operationRevisionIds: after }];
  });
}
