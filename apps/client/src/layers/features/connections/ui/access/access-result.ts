/**
 * The one line the page access card shows above Save: who keeps the app, who
 * gets it and who loses it if the person saves now (DOR-4899). The saved
 * outcome repeats the same sentence, so before and after read the same.
 *
 * @module features/connections/ui/access/access-result
 */
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  heldAccess,
  type CardAccessLevel,
  type CardDecision,
  type EveryAgentDecision,
  type WhoCanUse,
} from '../../lib/access-card-selection';
import { displayedAccessLevel } from '../../lib/access-level-offer';
import { selectionsFromPreview } from '../../lib/reconciliation-selection';
import { joinNames, LEVEL_LABELS } from './access-labels';

/** How many names a list spells out before "and N more". */
const NAMED_LIMIT = 3;

/** What the page card decided, as {@link accessResult} reads it. */
export interface AccessResultInput {
  /** The app's display name. */
  serviceName: string;
  /** The snapshot the decision is made against. */
  preview: ConnectorReconciliationPreview;
  /** Agents ticked on the checklist. */
  picked: ReadonlySet<string>;
  /** The chosen level. */
  level: CardAccessLevel | null;
  /** What Save writes for named agents. */
  decision: CardDecision;
  /** The "Who can use it?" answer. */
  who: WhoCanUse;
  /** What Save writes for every agent. */
  every: EveryAgentDecision;
}

/** The result line, plus every name when the line shortens its list. */
export interface AccessResult {
  /** One or more short sentences. */
  line: string;
  /** The full list of names, set only when the line says "and N more". */
  allNames?: string[];
}

/** "Ada", "Ada and Bo", "Ada, Bo and Cy", "Ada, Bo and 2 more". */
function shortList(names: string[]): string {
  return names.length <= NAMED_LIMIT
    ? joinNames(names)
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** One name takes the singular verb; a list takes the plural. */
function verb(names: string[], one: string, many: string): string {
  return names.length === 1 ? one : many;
}

/**
 * What saving the page card would do, in plain sentences, or `null` when Save
 * would change nothing or can't save yet (a level still to pick).
 *
 * - Every agent → picked: "Ada keeps Gmail. Every other agent loses it.", or
 *   "No agent will be able to use Gmail." with nobody ticked. A kept agent
 *   whose level changes says so after it ("Ada gets Read and write.").
 * - → Every agent: "Every agent can read Gmail, including agents you add later."
 * - Picked only: gains first, then losses, then level changes:
 *   "Bo gets Gmail (Read). Cy loses it. Ada drops to Read."
 *
 * @param input - The card's decision and the snapshot it was made against.
 */
export function accessResult(input: AccessResultInput): AccessResult | null {
  const { preview, serviceName, decision, every } = input;
  if (decision.needsLevel || every.needsLevel) return null;
  const nameOf = (agentId: string) =>
    preview.agents.find((agent) => agent.agentId === agentId)?.displayName ?? 'An agent';
  const own = selectionsFromPreview(preview);
  const shared = displayedAccessLevel(heldAccess(preview.everyAgent), preview.candidates);
  const stopsSharing = every.everyAgent?.operationRevisionIds.length === 0;

  if (input.who === 'every') {
    const next = every.everyAgent;
    if (!next || next.operationRevisionIds.length === 0) return null;
    const can = (next.level ?? input.level) === 'read-write' ? 'read and change' : 'read';
    return { line: `Every agent can ${can} ${serviceName}, including agents you add later.` };
  }

  // Sort every written grant by what the agent could do before Save: nothing
  // (a gain), or a level that goes up or down. Leaving "Every agent" counts
  // what every agent held, since that is what a ticked agent had until now.
  const gained = new Map<CardAccessLevel, string[]>();
  const raised: string[] = [];
  const lowered: string[] = [];
  for (const change of decision.changes) {
    if (change.operationRevisionIds.length === 0) continue;
    const ownBefore = displayedAccessLevel(heldAccess(own[change.agentId]), preview.candidates);
    const before = ownBefore === 'none' && stopsSharing ? shared : ownBefore;
    const after = change.level ?? input.level ?? 'read';
    if (before === 'custom' || before === after) continue;
    if (before === 'none')
      gained.set(after, [...(gained.get(after) ?? []), nameOf(change.agentId)]);
    else if (after === 'read-write') raised.push(nameOf(change.agentId));
    else lowered.push(nameOf(change.agentId));
  }
  if (stopsSharing && shared === 'read-write') {
    // Kept on its own Read grant, an agent loses the write every agent had.
    for (const agent of preview.agents) {
      const written = decision.changes.some((change) => change.agentId === agent.agentId);
      if (!input.picked.has(agent.agentId) || written) continue;
      if (displayedAccessLevel(heldAccess(own[agent.agentId]), preview.candidates) === 'read') {
        lowered.push(agent.displayName);
      }
    }
  }
  const levelChanges = [
    raised.length > 0 &&
      `${joinNames(raised)} ${verb(raised, 'gets', 'get')} ${LEVEL_LABELS['read-write']}.`,
    lowered.length > 0 &&
      `${joinNames(lowered)} ${verb(lowered, 'drops', 'drop')} to ${LEVEL_LABELS.read}.`,
  ].filter((sentence): sentence is string => Boolean(sentence));

  if (stopsSharing) {
    const kept = preview.agents
      .filter((agent) => input.picked.has(agent.agentId))
      .map((agent) => agent.displayName);
    if (kept.length === 0) return { line: `No agent will be able to use ${serviceName}.` };
    const keeps = `${shortList(kept)} ${verb(kept, 'keeps', 'keep')} ${serviceName}. Every other agent loses it.`;
    return {
      line: [keeps, ...levelChanges].join(' '),
      ...(kept.length > NAMED_LIMIT && { allNames: kept }),
    };
  }

  const sentences = [...gained].map(
    ([level, names]) =>
      `${joinNames(names)} ${verb(names, 'gets', 'get')} ${serviceName} (${LEVEL_LABELS[level]}).`
  );
  const removed = decision.removedAgentIds.map(nameOf);
  if (removed.length > 0) {
    // "it" only reads after a sentence that named the app.
    const what = sentences.length > 0 ? 'it' : serviceName;
    sentences.push(`${joinNames(removed)} ${verb(removed, 'loses', 'lose')} ${what}.`);
  }
  sentences.push(...levelChanges);
  return sentences.length > 0 ? { line: sentences.join(' ') } : null;
}
