/**
 * Pure selection rules for the "who can use it" access card: which simple
 * level an agent holds today, which agents to show first, and the grant
 * replacements a card decision writes. A level is saved as the level itself
 * with exactly its set in the snapshot ({@link accessLevelRevisionIds}, the
 * rule the server grants and follows with), so the card can never grant
 * anything the level would not, and reads a level back as the level the owner
 * chose, however the app's actions change (ADR 260929-071355).
 *
 * @module features/connections/lib/access-card-selection
 */
import {
  accessLevelRevisionIds,
  type ConnectorReconciliationEveryAgentSelection,
  type ConnectorReconciliationGrantSelection,
  type ConnectorReconciliationPreview,
  type ConnectorRequestAccess,
} from '@dorkos/shared/connector-schemas';
import {
  sameSelection,
  selectionsFromPreview,
  type AgentAccessSelection,
} from './reconciliation-selection';

/**
 * The two levels the card offers, the same two an agent asks for
 * (`ConnectorRequestAccess`), so a request and its answer are one vocabulary.
 * Exact per-action picks stay in the exact access editor.
 */
export type CardAccessLevel = ConnectorRequestAccess;

/** What an agent holds today, read against the card's presets. */
export type HeldAccess = 'none' | CardAccessLevel | 'custom';

/** How many agents the page mode lists before "Show all". */
export const VISIBLE_AGENT_LIMIT = 5;

/**
 * What one grant is: `'none'` when it holds no action it can use now, else
 * the level the owner chose when it has one, and `'custom'` for exact
 * actions. A level is never guessed from which actions happen to match
 * today, so an app that adds or reclassifies an action never turns "Read"
 * into exact actions; and a level that holds nothing yet (a change the
 * service has not applied) never reads as access the agent has.
 *
 * @param grant - The agent's (or every agent's) current revisions and level.
 */
export function heldAccess(grant: Partial<AgentAccessSelection> | undefined): HeldAccess {
  if ((grant?.operationRevisionIds?.length ?? 0) === 0) return 'none';
  return grant?.level ?? 'custom';
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
    if (heldAccess(current[agentId]) !== 'none') return 0;
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
 * The replacement sets a card decision writes, limited to the agents the
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
 * - A level is written as the level with exactly its set in the snapshot, so
 *   it keeps following the app afterwards.
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
  const target: AgentAccessSelection | null = level
    ? { operationRevisionIds: accessLevelRevisionIds(preview.candidates, level), level }
    : null;
  const inScope = new Set(scope);
  const changes: ConnectorReconciliationGrantSelection[] = [];
  const removedAgentIds: string[] = [];
  const downgradedAgentIds: string[] = [];
  let needsLevel = false;
  for (const agent of preview.agents) {
    if (!inScope.has(agent.agentId)) continue;
    const before = current[agent.agentId] ?? { operationRevisionIds: [] };
    const held = heldAccess(before);
    let after: AgentAccessSelection;
    if (!picked.has(agent.agentId)) {
      after = { operationRevisionIds: [] };
      if (held !== 'none') removedAgentIds.push(agent.agentId);
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
    if (!sameSelection(before, after)) {
      changes.push({ agentId: agent.agentId, ...after });
    }
  }
  return { changes, removedAgentIds, downgradedAgentIds, needsLevel };
}

/** The page card's two answers to "Who can use it?" (DOR-2420). */
export type WhoCanUse = 'picked' | 'every';

/** What the page card's "Every agent" answer would do on Save. */
export interface EveryAgentDecision {
  /**
   * The complete every-agent set to send, or `undefined` to leave sharing as
   * it is. An empty set stops sharing with every agent.
   */
  everyAgent?: ConnectorReconciliationEveryAgentSelection;
  /** "Every agent" is picked but the switch is mixed, so there is no level yet. */
  needsLevel: boolean;
}

/**
 * Where the page card starts: "Every agent" when the account is shared with
 * every agent now, otherwise "Only agents I pick".
 *
 * @param preview - Server snapshot.
 */
export function initialWhoCanUse(preview: ConnectorReconciliationPreview): WhoCanUse {
  return preview.everyAgent.operationRevisionIds.length > 0 ? 'every' : 'picked';
}

/**
 * The every-agent set a page-card decision writes (ADR 260926-192625). It
 * follows the same levels as the checklist, so "every agent" can never be
 * given anything a picked agent could not.
 *
 * - "Every agent" with a level sends that level and its set, unless it already
 *   holds that level. A set the card can't express (exact actions) is left
 *   alone until the person touches the level switch, as for an agent. A level
 *   with nothing in it yet shares nothing.
 * - "Only agents I pick" stops sharing when it is shared now, and otherwise
 *   sends nothing, so a card that never touched the question never writes it.
 * - Where sharing with every agent is unavailable, nothing is ever sent.
 *
 * @param preview - Server snapshot.
 * @param choice - What the person chose.
 * @param choice.who - "Only agents I pick" or "Every agent".
 * @param choice.level - The chosen level, or `null` while the switch is mixed.
 * @param choice.levelTouched - Whether the person picked a level on the switch.
 */
export function everyAgentDecision(
  preview: ConnectorReconciliationPreview,
  {
    who,
    level,
    levelTouched,
  }: { who: WhoCanUse; level: CardAccessLevel | null; levelTouched: boolean }
): EveryAgentDecision {
  if (!preview.everyAgent.available) return { needsLevel: false };
  const held = heldAccess(preview.everyAgent);
  if (who === 'picked') {
    return held !== 'none'
      ? { everyAgent: { operationRevisionIds: [] }, needsLevel: false }
      : { needsLevel: false };
  }
  if (held === 'custom' && !levelTouched) return { needsLevel: false };
  if (!level) return { needsLevel: held === 'none' };
  const target = accessLevelRevisionIds(preview.candidates, level);
  return held === level || target.length === 0
    ? { needsLevel: false }
    : { everyAgent: { operationRevisionIds: target, level }, needsLevel: false };
}

/**
 * Where the level switch starts for "Every agent": the level every agent
 * holds, Read when it is not shared yet, and `null` ("mixed", nothing
 * selected) when every agent holds exact actions the card can't express — so
 * the card never says "Read" while every agent can in fact write or delete.
 *
 * @param preview - Server snapshot.
 */
export function initialEveryAgentLevel(
  preview: ConnectorReconciliationPreview
): CardAccessLevel | null {
  const held = heldAccess(preview.everyAgent);
  return held === 'custom' ? null : initialCardLevel([held]);
}

/**
 * Whether saving "Every agent" as chosen leaves every agent able to write or
 * delete: the chosen level when there is one, otherwise what every agent
 * holds now. Drives the one plain warning the card shows.
 *
 * @param preview - Server snapshot.
 * @param level - The chosen level, or `null` while the switch is mixed.
 */
export function everyAgentCanWrite(
  preview: ConnectorReconciliationPreview,
  level: CardAccessLevel | null
): boolean {
  if (level) return level === 'read-write';
  const shared = new Set(preview.everyAgent.operationRevisionIds);
  return preview.candidates.some(
    (candidate) =>
      shared.has(candidate.operationRevisionId) && candidate.capabilityClassification !== 'read'
  );
}

/**
 * Whether saving "Every agent" as chosen leaves every agent holding a
 * high-risk (destructive-class) action. The card's levels never include one,
 * so this is only true while no level is chosen and the current shared set
 * holds one.
 *
 * @param preview - Server snapshot.
 * @param level - The chosen level, or `null` while the switch is mixed.
 */
export function everyAgentHoldsHighRisk(
  preview: ConnectorReconciliationPreview,
  level: CardAccessLevel | null
): boolean {
  if (level) return false;
  const shared = new Set(preview.everyAgent.operationRevisionIds);
  return preview.candidates.some(
    (candidate) =>
      shared.has(candidate.operationRevisionId) &&
      candidate.capabilityClassification === 'destructive'
  );
}

/**
 * What one agent can do on an account today, counting an "Every agent" grant
 * as well as its own: the chat card's question is whether THIS agent can use
 * the app, and an agent covered by "Every agent" already can. An every-agent
 * grant the server does not honour (a managed account) is left out, exactly as
 * the server's own check leaves it out.
 *
 * @param preview - Server snapshot.
 * @param agentId - The agent the question is about.
 * @param countEveryAgent - Whether "Every agent" counts. Only a card answering
 *   an agent's request counts it: there the question is "can it already?".
 *   Setting an agent's own access on its own does not.
 */
export function agentHeldAccess(
  preview: ConnectorReconciliationPreview,
  agentId: string,
  countEveryAgent = true
): HeldAccess {
  const own = heldAccess(selectionsFromPreview(preview)[agentId]);
  const shared =
    countEveryAgent && preview.everyAgent.available ? heldAccess(preview.everyAgent) : 'none';
  if (own === 'none') return shared;
  if (shared === 'none') return own;
  // Exact actions on either side are something no level describes.
  if (own === 'custom' || shared === 'custom') return 'custom';
  return own === 'read-write' || shared === 'read-write' ? 'read-write' : 'read';
}
