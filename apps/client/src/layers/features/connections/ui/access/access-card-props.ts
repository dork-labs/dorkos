import type { ServiceLogo } from '@/layers/entities/connectors';
import type { CardAccessLevel, WhoCanUse } from '../../lib/access-card-selection';
import type { RequestedWriteOffer } from '../../lib/access-level-offer';
import type { AccessCardVariant } from './AccessCardFrame';

interface SharedCardProps {
  /** The app's display name, e.g. "Gmail". */
  serviceName: string;
  /** What the catalog says about the app's logo, when the caller has its entry. */
  logo?: ServiceLogo;
  /** Leave without changing anything. Labelled "Skip" on the page and "Not now" for one agent. */
  onSkip?: () => void;
  /** Leave after a save has an outcome. Labelled "Done" once confirmed, "Close" otherwise. */
  onFinished?: () => void;
  /** Open the exact per-action editor for this account. Hidden when omitted. */
  onEditExactActions?: (connectionId: string) => void;
  /** A framed card of its own, or one section of a panel (see {@link AccessCardVariant}). */
  variant?: AccessCardVariant;
  /** Extra classes for the card's outer frame. */
  className?: string;
}

/**
 * The page's planning question: pick which agents can use one account.
 *
 * The agent checklist is the "Only agents you pick" answer. An "Every agent"
 * answer (DOR-2420) sits beside it as a sibling choice above the checklist;
 * the level switch and the save path below do not change for it.
 */
export interface PageAccessCardProps extends SharedCardProps {
  /** Pick agents for one connected account. */
  mode: 'page';
  /** The connected account whose access is chosen. */
  connectionId: string;
  /** Agents the caller knows are relevant right now; listed first after agents with access. */
  preferredAgentIds?: string[];
  /**
   * Start "Who can use it?" on this answer instead of the account's own, the
   * first time the card loads (the trust notice's Choose agents). Nothing
   * changes until Save.
   */
  startWho?: WhoCanUse;
  /**
   * Show what the picked level lets agents do in this app, right under the
   * level switch (the app's side panel). Hidden when omitted.
   */
  appActions?: { toolkit: string; providerInstanceId: string };
}

/** The chat's question: may this one agent use the app? It never offers "every agent". */
export interface AgentAccessCardProps extends SharedCardProps {
  /** Report the selected account's write offer; undefined while no preview is loaded. */
  onWriteOfferChange?: (offer: RequestedWriteOffer | undefined) => void;
  /** Answer for one fixed agent. */
  mode: 'agent';
  /** The agent asking. */
  agentId: string;
  /** The app's slug; with two connected accounts of it, the card asks which one first. */
  toolkit: string;
  /** A known account; skips the account question. */
  connectionId?: string;
  /**
   * Called once this agent's access is live on an account: after a save the
   * server confirmed and finished applying, or straight away when the agent
   * already holds what is picked. The chat card answers the agent's request
   * with it. When set, "Allow" stays pressable for an agent that can already
   * do this, since the question still needs an answer.
   */
  onAllowed?: (connectionId: string) => void;
  /**
   * What the agent asked for, when a request opened the card: the level starts
   * on the one it asked for, and the card shows the reason and the level
   * asked for, and says plainly what a lower pick leaves out.
   */
  request?: { readonly reason: string; readonly access: CardAccessLevel };
}

/** Props for the shared account-access card. */
export type ConnectionAccessCardProps = PageAccessCardProps | AgentAccessCardProps;
