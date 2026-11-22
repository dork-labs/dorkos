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
import { accessResult } from './access-result';

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
 * Who the saved change reaches, including anyone who lost access. The page
 * card repeats the line it showed above Save ({@link accessResult}), so before
 * and after read the same; the chat's one-agent card names its agent.
 *
 * @param input - The card's decision and the snapshot it was made against.
 */
export function savedSummary(input: SavedSummaryInput): string | undefined {
  const { preview, serviceName, level } = input;
  if (input.mode === 'agent') {
    const name =
      preview.agents.find((agent) => agent.agentId === input.agentId)?.displayName ?? 'The agent';
    return levelSentence(name, level, serviceName);
  }
  return accessResult(input)?.line;
}
