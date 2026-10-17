/**
 * Waking the agents a doc comment mentions (DOR-2983).
 *
 * ## The path a wake takes
 *
 * 1. **Whether it may.** Every wake goes through the rooms' cascade guard
 *    (`rooms/cascade-guard.ts`), with the install's own room limits
 *    (`rooms.maxAgentDepth`, `rooms.maxTurnsPerAgentPerCascade`). A comment
 *    carries the cascade it belongs to: a person's comment starts a fresh one;
 *    an agent's comment written in a turn a comment woke continues that turn's
 *    cascade; an agent's comment with no such turn behind it is stamped
 *    already spent (`deriveCascade`), so it wakes nobody. There is no path
 *    from one agent's comment to another agent's turn that the guard does not
 *    see.
 * 2. **Where it lands.** The chat DorkOS keeps with that agent for doc
 *    comments (`doc_comment_agent_chats`), opened in the agent's home on the
 *    first mention. Delivered through `dispatchSessionMessage`, which queues
 *    behind a running turn.
 * 3. **The power it carries.** The owner's own comment carries none of its own
 *    (the chat's settings decide). Anybody else's is held to a ceiling: an
 *    agent's to the level its own turn ran at, anyone else's to the runtime's
 *    default. The bounded lock identity makes the dispatcher hold a queued row
 *    to that ceiling, and to the runtime's default after a restart
 *    (`doc-comment-client-id.ts`).
 * 4. **What the woken turn carries on.** When the turn starts, its chat is
 *    remembered with the cascade it was woken under, so a comment the agent
 *    writes in that turn continues the same chain (step 1).
 *
 * @module services/docs/comments/comment-wake
 */
import crypto from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import type { TurnPermissionCeiling, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { logError, logger } from '../../../lib/logger.js';
import { evaluateCascade, type CascadeRefusalReason } from '../../rooms/cascade-guard.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
  type DispatchSessionMessageResult,
} from '../../session/launch/launch-session.js';
import {
  onDispatchLifecycle,
  type DispatchLifecycleEvent,
} from '../../session/message-dispatcher.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { CommentAgent, CommentTrust } from './comment-directory.js';
import type { DocCommentStore } from './comment-store.js';
import {
  DOC_COMMENT_BOUNDED_CLIENT_ID,
  DOC_COMMENT_OWNER_CLIENT_ID,
} from './doc-comment-client-id.js';

/** How many woken chats, and wakes waiting to start, are remembered at once. */
export const WAKE_MEMORY = 2_000;

/** The cascade a woken turn carries: what a comment it writes continues. */
export interface CommentCascade {
  /** The comment that began the chain. */
  root: string;
  /** How many automatic replies deep the woken turn is. */
  depth: number;
}

/** The limits a wake is measured against, resolved per call. */
export interface CommentWakeLimits {
  /** Whether the guard applies at all (`rooms.turnLimitsEnabled`). */
  enabled: boolean;
  /** `rooms.maxAgentDepth`. */
  maxAgentDepth: number;
  /** `rooms.maxTurnsPerAgentPerCascade`. */
  maxTurnsPerAgentPerCascade: number;
}

/** One agent a comment mentioned. */
export interface WakeTarget extends CommentAgent {
  /** The agent's author id. */
  authorId: string;
}

/** What became of one mention. */
export type WakeOutcome =
  | { authorId: string; name: string; woken: true }
  | {
      authorId: string;
      name: string;
      woken: false;
      /** Why: a reply limit, or the agent or the machine could not take it. */
      reason: CascadeRefusalReason | 'unavailable';
    };

/** One comment's wakes. */
export interface CommentWakeRequest {
  /** The comment's cascade. */
  cascade: CommentCascade;
  /** How much its author's words count for. */
  trust: CommentTrust;
  /** The chat the author wrote from, when an agent's tool wrote it. */
  authorSessionId?: string;
  /** Who to wake. */
  targets: readonly WakeTarget[];
  /** The message each target reads. */
  render: (target: WakeTarget) => string;
}

/** What the waker needs. Everything after `store` has a production default. */
export interface CommentWakeDeps {
  /** Kept chats and per-author counts. */
  store: Pick<DocCommentStore, 'keptChat' | 'keepChat' | 'commentsByAuthorInCascade'>;
  /** The limits, read per call. */
  limits: () => CommentWakeLimits;
  /** The level a chat's latest turn ran at, or undefined when not known. */
  turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined;
  /** Mesh, when running. */
  meshCore: () => MeshCore | undefined;
  /** The room binding port, read at call time. */
  roomSessionPlace?: () => RoomSessionPlacePort | undefined;
  /** The send itself. */
  dispatch?: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>;
  /** Subscribe to the dispatcher's lifecycle. */
  onLifecycle?: (listener: (event: DispatchLifecycleEvent) => void) => () => void;
  /** The clock (tests pin it). */
  now?: () => number;
}

/** Wakes mentioned agents, and remembers which chats a comment woke. */
export class CommentWaker {
  private readonly dispatch: NonNullable<CommentWakeDeps['dispatch']>;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  /** Wakes sent and not started yet, by message id. */
  private readonly pending = new Map<string, CommentCascade>();
  /** The cascade each woken chat's latest comment turn carries, by filing id. */
  private readonly woken = new Map<string, CommentCascade>();

  /**
   * Build the waker, already listening to the dispatcher.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: CommentWakeDeps) {
    this.dispatch = deps.dispatch ?? dispatchSessionMessage;
    this.now = deps.now ?? Date.now;
    this.unsubscribe = (deps.onLifecycle ?? onDispatchLifecycle)((event) => this.onDispatch(event));
  }

  /** Stop listening, for a server shutting down. */
  stop(): void {
    this.unsubscribe();
  }

  /**
   * The cascade a chat's current comment turn carries, or undefined when no
   * comment woke it. What a comment the agent writes from that chat continues.
   *
   * @param sessionId - The calling chat, from the verified turn.
   */
  cascadeFor(sessionId: string): CommentCascade | undefined {
    return this.woken.get(primaryOf(sessionId));
  }

  /**
   * Wake every target a comment mentioned, each through the cascade guard.
   * Never throws: a wake that fails is reported, and the comment stands.
   *
   * @param request - The comment and who it mentioned.
   * @returns What became of each mention, in order.
   */
  async wake(request: CommentWakeRequest): Promise<WakeOutcome[]> {
    const outcomes: WakeOutcome[] = [];
    for (const target of request.targets) {
      outcomes.push(await this.wakeOne(request, target));
    }
    return outcomes;
  }

  private async wakeOne(request: CommentWakeRequest, target: WakeTarget): Promise<WakeOutcome> {
    const who = { authorId: target.authorId, name: target.name };
    const limits = this.deps.limits();
    let depth = request.cascade.depth + 1;
    if (limits.enabled) {
      const decision = evaluateCascade(
        target.authorId,
        {
          root: request.cascade.root,
          depth: request.cascade.depth,
          turnsByAuthor: this.deps.store.commentsByAuthorInCascade(request.cascade.root),
        },
        limits
      );
      if (!decision.allowed) return { ...who, woken: false, reason: decision.reason };
      depth = decision.depth;
    }

    const kept = this.deps.store.keptChat(target.agentId);
    const sessionId = kept ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const ceiling = this.ceilingFor(request);
    this.remember(this.pending, messageId, { root: request.cascade.root, depth });
    try {
      const result = await this.dispatch({
        origin: { kind: 'doc-comment' },
        sessionId,
        messageId,
        request: { content: request.render(target), agentPath: target.agentPath },
        clientId:
          request.trust === 'owner' ? DOC_COMMENT_OWNER_CLIENT_ID : DOC_COMMENT_BOUNDED_CLIENT_ID,
        meshCore: this.deps.meshCore(),
        roomSessionPlace: this.deps.roomSessionPlace?.(),
        countsTowardLaunchCap: true,
        ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
      });
      if (isSessionLaunchRefusal(result) || !result.accepted) {
        this.pending.delete(messageId);
        return { ...who, woken: false, reason: 'unavailable' };
      }
      const chatId = result.canonicalId ?? sessionId;
      if (chatId !== kept) {
        this.deps.store.keepChat(target.agentId, chatId, new Date(this.now()).toISOString());
      }
      return { ...who, woken: true };
    } catch (err) {
      this.pending.delete(messageId);
      logger.warn('[doc-comments] could not wake a mentioned agent', {
        agentId: target.agentId,
        ...logError(err),
      });
      return { ...who, woken: false, reason: 'unavailable' };
    }
  }

  /** The loosest level a wake may run at: none of its own for the owner's comment. */
  private ceilingFor(request: CommentWakeRequest): TurnPermissionCeiling | undefined {
    switch (request.trust) {
      case 'owner':
        return undefined;
      case 'agent':
        return (
          (request.authorSessionId ? this.deps.turnLevelOf(request.authorSessionId) : undefined) ??
          'runtime-default'
        );
      case 'outsider':
        return 'runtime-default';
    }
  }

  private onDispatch(event: DispatchLifecycleEvent): void {
    const cascade = this.pending.get(event.messageId);
    if (!cascade) return;
    if (event.phase === 'started') {
      this.remember(this.woken, primaryOf(event.sessionId), cascade);
      return;
    }
    // Settled or dropped: the wake is over either way. The chat keeps the
    // cascade it was last woken under until another comment wakes it.
    this.pending.delete(event.messageId);
  }

  /** Set a key as the newest, dropping the oldest past {@link WAKE_MEMORY}. */
  private remember(map: Map<string, CommentCascade>, key: string, cascade: CommentCascade): void {
    map.delete(key);
    map.set(key, cascade);
    if (map.size > WAKE_MEMORY) map.delete(map.keys().next().value!);
  }
}
