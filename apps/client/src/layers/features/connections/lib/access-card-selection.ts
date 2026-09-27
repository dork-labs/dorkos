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
 * The level a card's switch should start on: the preset every preset-holding
 * agent already shares, Read when nobody holds one, and `null` ("mixed", no
 * segment selected) when they differ. A mixed switch changes nobody until the
 * person picks a level for everyone on purpose.
 *
 * @param held - Current access of the agents the card is about.
 */
export function initialCardLevel(held: HeldAccess[]): CardAccessLevel | null {
  const presets = new Set(
    held.filter((level): level is CardAccessLevel => level === 'read' || level === 'read-write')
  );
  if (presets.size === 0) return 'read';
  return presets.size === 1 ? [...presets][0] : null;
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

/** Everything one card decision would do, before it is saved. */
export interface CardDecision {
  /** Exact replacement sets for agents whose access changes. */
  changes: ConnectorReconciliationGrantSelection[];
  /** Agents that hold access now and would lose all of it. */
  removedAgentIds: string[];
  /** Agents on Read and write that the chosen level would drop to Read. */
  downgradedAgentIds: string[];
  /** A newly picked agent has no level yet because the switch is mixed. */
  needsLevel: boolean;
}

/**
 * The exact replacement sets a card decision writes, limited to the agents the
 * card is about (`scope`) and to those whose set actually changes. An agent
 * outside the scope is never written, whatever it holds.
 *
 * - A picked agent that had no access gets the chosen level. With a mixed
 *   switch it gets nothing yet and {@link CardDecision.needsLevel} is set.
 * - A picked agent on a preset moves to the chosen level only once the person
 *   has touched the level switch, so opening the card and adding one agent
 *   never quietly changes anyone else.
 * - A picked agent with exact per-action access keeps it untouched: the card
 *   cannot express that set, so it never overwrites it.
 * - An agent in scope that had access and is no longer picked loses it, and
 *   is named in {@link CardDecision.removedAgentIds} so the card can say so.
 * - A preset holder moved from Read and write to Read is named in
 *   {@link CardDecision.downgradedAgentIds}; with `allowDowngrade: false` (the
 *   chat's one-agent answer) it keeps its current access instead.
 *
 * @param preview - Server snapshot the decision is made against.
 * @param decision - What the person chose.
 * @param decision.scope - Agents this card decides for; everyone else is left alone.
 * @param decision.picked - Agents the person picked.
 * @param decision.level - The chosen level, or `null` while the switch is mixed.
 * @param decision.levelTouched - Whether the person picked a level on the switch.
 * @param decision.allowDowngrade - Whether the decision may lower a preset (default true).
 */
export function cardDecision(
  preview: ConnectorReconciliationPreview,
  {
    scope,
    picked,
    level,
    levelTouched,
    allowDowngrade = true,
  }: {
    scope: readonly string[];
    picked: ReadonlySet<string>;
    level: CardAccessLevel | null;
    levelTouched: boolean;
    allowDowngrade?: boolean;
  }
): CardDecision {
  const current = selectionsFromPreview(preview);
  const target = level ? revisionIdsForAccessLevel(preview.candidates, level) : null;
  const inScope = new Set(scope);
  const changes: ConnectorReconciliationGrantSelection[] = [];
  const removedAgentIds: string[] = [];
  const downgradedAgentIds: string[] = [];
  let needsLevel = false;
  for (const agent of preview.agents) {
    if (!inScope.has(agent.agentId)) continue;
    const before = current[agent.agentId] ?? [];
    const held = heldAccess(preview.candidates, before);
    let after: string[];
    if (!picked.has(agent.agentId)) {
      after = [];
      if (before.length > 0) removedAgentIds.push(agent.agentId);
    } else if (held === 'none') {
      if (!target) needsLevel = true;
      after = target ?? before;
    } else if (held === 'custom' || !levelTouched || !target) {
      after = before;
    } else if (held === 'read-write' && level === 'read') {
      after = allowDowngrade ? target : before;
      if (allowDowngrade) downgradedAgentIds.push(agent.agentId);
    } else {
      after = target;
    }
    if (!sameIds(before, after)) {
      changes.push({ agentId: agent.agentId, operationRevisionIds: after });
    }
  }
  return { changes, removedAgentIds, downgradedAgentIds, needsLevel };
}
