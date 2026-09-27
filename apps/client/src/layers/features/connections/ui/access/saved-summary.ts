/**
 * What a confirmed save of the access card means, in one or two plain lines.
 *
 * @module features/connections/ui/access/saved-summary
 */
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type {
  CardAccessLevel,
  CardDecision,
  EveryAgentDecision,
  WhoCanUse,
} from '../../lib/access-card-selection';
import { joinNames } from './access-labels';

/** What the card decided, as {@link savedSummary} reads it. */
export interface SavedSummaryInput {
  /** The card's mode; the chat's one-agent card names its agent. */
  mode: 'page' | 'agent';
  /** The one agent the chat card answers for. */
  agentId?: string;
  /** The app's display name. */
  serviceName: string;
  /** The snapshot the save was made against. */
  preview: ConnectorReconciliationPreview;
  /** Agents ticked on the checklist. */
  picked: ReadonlySet<string>;
  /** The chosen level. */
  level: CardAccessLevel | null;
  /** What was written for named agents. */
  decision: CardDecision;
  /** The page card's "Who can use it?" answer. */
  who: WhoCanUse;
  /** What was written for every agent. */
  every: EveryAgentDecision;
}

function levelSentence(subject: string, level: CardAccessLevel | null, serviceName: string) {
  return level === 'read-write'
    ? `${subject} can read and write in ${serviceName}.`
    : `${subject} can read ${serviceName}.`;
}

/**
 * Who the saved change reaches, including anyone who lost access. With every
 * agent chosen it says so ("Every agent can read Gmail."), and turning every
 * agent off says that too, so the line is never narrower than what was saved.
 *
 * @param input - The card's decision and the snapshot it was made against.
 */
export function savedSummary(input: SavedSummaryInput): string {
  const { preview, serviceName, decision, level } = input;
  const nameOf = (agentId: string) =>
    preview.agents.find((agent) => agent.agentId === agentId)?.displayName ?? 'The agent';
  if (input.mode === 'agent') {
    return levelSentence(nameOf(input.agentId ?? ''), level, serviceName);
  }
  if (input.who === 'every') {
    return levelSentence('Every agent', level, serviceName);
  }
  const kept = preview.agents
    .filter((agent) => input.picked.has(agent.agentId))
    .map((agent) => agent.displayName);
  const lines = [
    kept.length > 0
      ? `${joinNames(kept)} can use ${serviceName}.`
      : `No agent can use ${serviceName}.`,
  ];
  if (input.every.everyAgent?.operationRevisionIds.length === 0) {
    lines.push(`${serviceName} is no longer shared with every agent.`);
  }
  const downgraded = decision.downgradedAgentIds.map(nameOf);
  if (downgraded.length > 0) lines.push(`${joinNames(downgraded)} can now only read.`);
  const removed = decision.removedAgentIds.map(nameOf);
  if (removed.length > 0) lines.push(`${joinNames(removed)} can no longer use it.`);
  return lines.join(' ');
}
