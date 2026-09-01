/**
 * The Approve/Deny card a room-bound Ask sends into a bridged chat (spec
 * `ask-entitlement` §5.2).
 *
 * A direct-bound agent has always sent one of these: the runtime pauses, the
 * adapter renders two buttons, and the person on Telegram or Slack presses one.
 * An agent answering for a ROOM had nothing — the room's own log said it was
 * waiting, a minute late and naming nothing, and the approval it needed lived
 * in a cockpit the reader might not have open. This closes that gap without
 * inventing a second approval policy: the card is the shipped
 * `approval_required` payload, on the chat's shipped outbound subject, and the
 * click comes back on the shipped approval bus.
 *
 * ## Only an approval, and only sometimes
 *
 * **Only the `approval` kind of interaction produces a card.** A question needs
 * free text back and an elicitation needs a form; the adapters' button path
 * carries a boolean and neither can ride it. Both kinds get the waiting
 * sentence (`notice-copy.ts`) and nothing else.
 *
 * **And only where every reader may act on it.** {@link bridgedAskIsActionable}
 * is the whole of that judgement, and it refuses far more than it admits — see
 * its doc for why a group chat never qualifies.
 *
 * ## The provenance is `initiate`, deliberately
 *
 * An Ask card is DorkOS starting a message the person did not just prompt, so
 * an operator who switched initiate off for that chat does not receive
 * unsolicited approval cards. Claiming `reply` would misrepresent provenance to
 * the consent gate, which is the exact class of thing
 * `ChatBridgeDelivery.classifyProvenance` guards against.
 *
 * @module services/relay/chat-bridge/ask-card
 */
// The narrow subpath for the value import; the barrel is types only here, which
// costs nothing at runtime.
import { toIdList } from '@dorkos/relay/approver-allowlist';
import type { PublishOptions, PublishResult } from '@dorkos/relay';

import { logger } from '../../../lib/logger.js';
import { externalAuthorParts, isExternalNaturalKey } from '../../rooms/author-registry.js';
import { onProjectorInteractionChange } from '../../session/session-state-projector.js';
import type { InteractionChange } from '../../session/session-state-projector.js';
import type { PendingInteractionDTO } from '@dorkos/shared/schemas';
import { buildBridgePrincipal } from '../bridge-principal.js';
import { bridgedAskIsActionable, type ExternalChatAuthor } from './ask-audience.js';
import type { Bridge, BridgeStore } from './bridge-store.js';

/** Which room a session answers for, as a port — never an import of the ledger. */
export interface AskRoomBindings {
  /** The room binding a session answers for, or `undefined` when it answers for none. */
  bindingForSession(sessionId: string): { roomId: string; authorId: string } | undefined;
}

/** A room's membership rows, for working out who is on the other end of a chat. */
export interface AskRosterReader {
  /**
   * Every member of one room.
   *
   * @param roomId - The room.
   */
  listMembers(roomId: string): readonly { readonly authorId: string }[];
}

/** Enough of the author registry to tell an outside person from a local one. */
export interface AskAuthorReader {
  /**
   * One author by id.
   *
   * @param id - The author id.
   */
  getById(id: string): { readonly naturalKey: string } | null | undefined;
}

/** The relay publish this card rides out on — the same port outbound delivery uses. */
export interface AskCardPublisher {
  /**
   * Publish the card onto the chat's own subject.
   *
   * @param subject - The chat's `relay.human.*` subject.
   * @param payload - The `approval_required` StreamEvent payload.
   * @param options - Publish options; `from` carries the bridge principal.
   */
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
}

/** Everything {@link BridgedAskDelivery} is constructed from. */
export interface BridgedAskDeliveryDeps {
  /** Which room a session answers for. */
  bindings: AskRoomBindings;
  /** The bridge store, for the room's live bridge. */
  bridges: Pick<BridgeStore, 'findBridgeByRoom'>;
  /** The room's membership rows. */
  members: AskRosterReader;
  /** The author registry, for each member's natural key. */
  authors: AskAuthorReader;
  /**
   * The approver allowlist configured on one adapter, in whatever shape config
   * held it — `toIdList` inside `mayApprove` tolerates the textarea form the
   * setup form produces.
   *
   * @param adapterId - The adapter the bridge belongs to.
   */
  approverAllowlistFor(adapterId: string): unknown;
  /** Build a chat's outbound subject from its bridge row. */
  resolveSubject(bridge: Bridge): string | null;
  /** Where the card is published. */
  publisher: AskCardPublisher;
}

/** A card this process sent and has not seen resolved. */
interface StandingCard {
  /** The room whose agent is parked. */
  roomId: string;
  /** The agent's author id in that room. */
  authorId: string;
}

/**
 * Whether a publish actually reached the chat.
 *
 * Two ways it does not, and the consent gate's is the one that matters here: it
 * comes back as a REJECTION rather than a throw (spec §6.6), so a caller that
 * only caught exceptions would count a refused card as sent. The other is an
 * adapter that took the call and failed at the platform.
 *
 * `adapterResult` is absent on a publish that no adapter handled at all, which
 * is also not a delivery.
 *
 * @param result - What the relay publish returned.
 */
function delivered(result: PublishResult): boolean {
  if ((result.rejected ?? []).some((r) => r.reason === 'initiate_denied')) return false;
  return result.adapterResult?.success === true;
}

/**
 * Sends an Approve/Deny card into a bridged chat when a room-bound turn parks
 * on a tool approval, and remembers which ones are standing.
 *
 * Subscribes to `onProjectorInteractionChange` — the same seam the session-list
 * broadcaster reads — so a room-bound Ask on ANY runtime is covered without
 * adapter work.
 */
export class BridgedAskDelivery {
  /** `interactionId` → the (room, agent) its card is standing in. */
  private standing = new Map<string, StandingCard>();
  private unsubscribe: (() => void) | undefined;

  /**
   * Build a delivery bound to one set of seams. Listens for nothing until
   * {@link BridgedAskDelivery.start} is called.
   *
   * @param deps - The rooms, bridge and relay seams this needs.
   */
  constructor(private readonly deps: BridgedAskDeliveryDeps) {}

  /**
   * Start listening for parked turns. Idempotent.
   *
   * Separate from the constructor so a test can build one without attaching to
   * the process-wide projector registry.
   */
  start(): void {
    this.unsubscribe ??= onProjectorInteractionChange((change) => this.onChange(change));
  }

  /** Stop listening and forget every standing card. Idempotent. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.standing.clear();
  }

  /**
   * Whether a card this process sent is still standing for one room's agent.
   *
   * The outbound notice path asks this before delivering an `awaiting_approval`
   * sentence: an approver who already has the card would otherwise see a
   * near-duplicate line a minute later. The room's own log is untouched either
   * way — the notice is always written, only its delivery is suppressed — which
   * keeps the cockpit's reading of the room identical.
   *
   * **The key is the (room, agent) pair, not the interaction**, because a
   * waiting notice carries no interaction id — only `subjectAuthorId`. So a
   * standing approval card for an agent suppresses ANY waiting sentence for
   * that agent in that room, including the question and elicitation kinds the
   * card path deliberately does not cover. In practice a turn parks on one
   * thing at a time, so the two coincide; where they would not, the card is
   * the louder and more actionable of the two and the sentence is the one
   * worth losing.
   *
   * @param roomId - The room the notice is about.
   * @param authorId - The agent the notice is about (`subjectAuthorId`).
   * @returns Whether to skip delivering the sentence.
   */
  hasStandingCard(roomId: string, authorId: string | undefined): boolean {
    if (authorId === undefined) return false;
    for (const card of this.standing.values()) {
      if (card.roomId === roomId && card.authorId === authorId) return true;
    }
    return false;
  }

  /**
   * React to one projector transition.
   *
   * A `resolved` clears this process's record so the suppression above does not
   * outlive the turn. The card in the chat is edited by the adapter's own click
   * handler, exactly as a direct-bind card is; a card nobody pressed is left
   * standing, which is what the direct-bind path already does.
   *
   * @param change - The transition a projector announced.
   */
  private onChange(change: InteractionChange): void {
    if (change.type === 'resolved') {
      this.standing.delete(change.interactionId);
      return;
    }
    // Only an approval produces a card; a question needs free text back and an
    // elicitation needs a form, and the adapters' button path carries a
    // boolean. Narrowed HERE, and handed to `deliver` already narrowed, so
    // there is exactly one place that decides which kinds are cardable.
    const interaction = change.interaction;
    if (interaction.type !== 'approval') return;
    void this.deliver(change, interaction).catch((err: unknown) => {
      logger.warn('[BridgedAskDelivery] failed to send an approval card', {
        sessionId: change.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Resolve the audience and, when it qualifies, publish one card.
   *
   * Every step is a stop rather than a fallback: no binding, no live bridge, no
   * subject, or an audience that does not qualify all mean this Ask stays where
   * it is.
   *
   * @param change - The transition, for the session id.
   * @param interaction - The parked approval, already narrowed by
   *   {@link BridgedAskDelivery.onChange}.
   */
  private async deliver(
    change: Extract<InteractionChange, { type: 'pending' }>,
    interaction: Extract<PendingInteractionDTO, { type: 'approval' }>
  ): Promise<void> {
    const binding = this.deps.bindings.bindingForSession(change.sessionId);
    if (!binding) return;

    const bridge = this.deps.bridges.findBridgeByRoom(binding.roomId);
    if (!bridge) return;

    const approvers = this.approversFor(bridge.adapterId);
    if (
      !bridgedAskIsActionable({
        bridge,
        externalAuthors: this.externalAuthorsOf(binding.roomId),
        approvers,
      })
    ) {
      return;
    }

    const subject = this.deps.resolveSubject(bridge);
    if (!subject) return;

    const result = await this.deps.publisher.publish(
      subject,
      {
        // The shipped card payload, verbatim: the adapters read
        // `payload.data.{toolCallId,toolName,input,timeoutMs}` and take the
        // session and agent off `data` too, so the click round-trips to the
        // same `approveTool` a cockpit press would reach.
        type: 'approval_required',
        data: {
          toolCallId: interaction.id,
          toolName: interaction.toolName,
          input: interaction.input,
          ...(interaction.timeoutMs === undefined ? {} : { timeoutMs: interaction.timeoutMs }),
          agentId: binding.authorId,
          ccaSessionKey: change.sessionId,
        },
      },
      {
        from: buildBridgePrincipal('initiate', bridge.adapterId, bridge.chatId),
        serverBridgePrincipal: true,
      }
    );

    // **Recorded only on a card that really landed.** The record's one job is
    // to suppress the waiting sentence, and a card the consent gate refused
    // (`initiate_denied` on a `canInitiate: false` binding) or the platform
    // never accepted would suppress it in exchange for nothing — the approver
    // would get silence, which is the failure this whole path exists to end.
    if (!delivered(result)) {
      logger.info('[BridgedAskDelivery] the chat did not take the approval card', {
        roomId: binding.roomId,
        sessionId: change.sessionId,
        consentDenied: (result.rejected ?? []).some((r) => r.reason === 'initiate_denied'),
      });
      return;
    }
    this.standing.set(interaction.id, { roomId: binding.roomId, authorId: binding.authorId });
  }

  /**
   * The approver ids configured on one adapter.
   *
   * `toIdList` is the adapters' own reader, so the textarea shape the setup
   * form produces — one id per line — is tolerated here exactly as it is at the
   * click. A throw (an adapter config that cannot be read) must not stop the
   * turn; it means nobody is authorized, which is what an empty list says.
   *
   * @param adapterId - The adapter the bridge belongs to.
   */
  private approversFor(adapterId: string): string[] {
    try {
      return toIdList(this.deps.approverAllowlistFor(adapterId));
    } catch (err) {
      logger.warn('[BridgedAskDelivery] could not read an adapter’s approver list', {
        adapterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * The people from outside this machine on a room's roster.
   *
   * The platform user id is read back through `externalAuthorParts`, the ONE
   * parse of that key shape — a second one is how two readers come to disagree
   * about where a person is.
   *
   * @param roomId - The room.
   */
  private externalAuthorsOf(roomId: string): ExternalChatAuthor[] {
    const external: ExternalChatAuthor[] = [];
    for (const member of this.deps.members.listMembers(roomId)) {
      const author = this.deps.authors.getById(member.authorId);
      if (!author || !isExternalNaturalKey(author.naturalKey)) continue;
      const { instanceId, platformUserId } = externalAuthorParts(author.naturalKey);
      external.push({ instanceId, platformUserId });
    }
    return external;
  }
}
