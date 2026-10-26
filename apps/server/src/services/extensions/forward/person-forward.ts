/**
 * A person's comment, typed in a mini app, forwarded into their Direct chat
 * with an agent as their own words (`api.forward`, DOR-3325).
 *
 * ## Why this is not `ctx.agent.send`
 *
 * `ctx.agent.send` is the app speaking. Its server code chooses the words, so
 * the agent reads them fenced as app data, and the turn runs no looser than
 * the runtime default. A person replying to an item in a mini app is not the
 * app speaking, and routing their reply that way capped the agent's turn and
 * filled their screen with approval cards. Here DorkOS takes the words from
 * the person's own POST (`routes/extensions-forward.ts` reads the body itself;
 * no extension code sits between it and the message) and posts them into the
 * person's Direct chat with the agent exactly as typing there does.
 *
 * ## The four things that keep it honest
 *
 * 1. **The agent is the person's pick, never the request's.** Each mini app
 *    has a list of agent ids the person allowed (`extensions.forwardAgents`,
 *    `operator-only`). A forward may NAME one, but reaches it only when it is
 *    on the list; with none named, the list's only agent. Anything else is
 *    refused. The first time, the refusal holds the typed text here
 *    ({@link PersonForwards.hold}) and the app draws a core prompt, "Send
 *    {app} comments to {agent}?", with the agent's registered name; Allow
 *    adds that one id and sends the text DorkOS kept, never anything the app
 *    sends again ({@link PersonForwards.allow}).
 * 2. **Only the typed text is the person's.** The item is named by id. Its
 *    title rides beside the post in `body.via`, which the app shows as quoted
 *    text from the mini app; an agent sees the app's name and the item's id,
 *    never the title.
 * 3. **Text only.** No attachments, no thread, no delivery mode, no steer or
 *    interrupt: the post is a plain new message, and the room starts the
 *    agent's turn the way any message from the person does.
 * 4. **Replies are the agent's.** {@link PersonForwards.replies} reads the
 *    agent's own posts that answer the forward (`body.answersEntryId`), under
 *    the agent's name, as markdown with HTML defused.
 *
 * The route records one audit row per forward.
 *
 * @module services/extensions/forward/person-forward
 */
import type { ForwardVia } from '@dorkos/shared/chat-messages';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type {
  ForwardErrorCode,
  ForwardReceipt,
  ForwardReply,
  ForwardStamp,
} from '@dorkos/extension-api';
import crypto from 'node:crypto';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { defuseReplyMarkdown } from './reply-markdown.js';
import type { AuthorRecord } from '../../rooms/index.js';
import type { PersonPostBound } from '../../rooms/messages/room-entry-writer.js';

/** Most answers {@link PersonForwards.replies} returns for one forward. */
export const FORWARD_REPLIES_MAX = 20;

/** Most agents one mini app may forward to. Mirrors the config schema. */
export const FORWARD_AGENTS_MAX = 20;

/** How long a comment waits for the person's Allow before it is dropped. */
export const PENDING_FORWARD_TTL_MS = 10 * 60_000;

/** Most comments waiting for an Allow at once, across every mini app. */
export const PENDING_FORWARDS_MAX = 50;

/** A forward refused, with nothing posted. */
export class PersonForwardError extends Error {
  /**
   * Refuse a forward.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   * @param suggestedAgentId - For `no_agent`: the registered agent the
   *   request named, which the person may be asked to allow.
   */
  constructor(
    readonly code: ForwardErrorCode,
    message: string,
    readonly suggestedAgentId?: string
  ) {
    super(message);
    this.name = 'PersonForwardError';
  }
}

/**
 * The agents a person allowed one mini app to forward to, by Mesh id. Empty
 * when none. Read per call, so a change takes effect on the next forward.
 *
 * @param extensionId - The mini app.
 */
export function forwardAgentsOf(extensionId: string): readonly string[] {
  return configManager.get('extensions')?.forwardAgents?.[extensionId] ?? [];
}

/**
 * Replace the agents one mini app may forward to. An empty list removes its
 * entry. Only `PUT /api/extensions/:id/forward-agents` and the first-use
 * Allow call this, each behind its person bar. Spreads the whole `extensions`
 * section, because the store write replaces the subtree and naming only this
 * key would erase every approval beside it.
 *
 * @param extensionId - The mini app.
 * @param agentIds - The agents, deduplicated here.
 * @returns The agents now allowed.
 */
export function setForwardAgents(extensionId: string, agentIds: readonly string[]): string[] {
  const before = configManager.get('extensions');
  const next = { ...(before?.forwardAgents ?? {}) };
  const unique = [...new Set(agentIds)].slice(0, FORWARD_AGENTS_MAX);
  if (unique.length === 0) delete next[extensionId];
  else next[extensionId] = unique;
  configManager.set('extensions', { ...before, forwardAgents: next });
  logConfigWrite(
    'choosing the agents a mini app forwards to',
    'extensions',
    before,
    configManager.get('extensions')
  );
  return unique;
}

/** What the forward service needs. Read at call time, so a late start is seen. */
export interface PersonForwardDeps {
  /** The rooms service, or undefined while rooms are not running. */
  rooms: () =>
    | {
        post(
          roomId: string,
          input: { authorId: string; text: string; via: ForwardVia },
          unverifiedAgent: boolean,
          bound?: PersonPostBound
        ): RoomEntry;
        readEntry(roomId: string, viewerAuthorId: string, entryId: string): RoomEntry | null;
        entriesAfter(roomId: string, afterSeq: number): RoomEntry[];
      }
    | undefined;
  /** The person's Direct chats, or undefined while rooms are not running. */
  directChats: () =>
    | {
        ensureForAgent(
          agentPath: string,
          displayName: string
        ): {
          roomId: string;
          agentAuthorId: string;
        };
      }
    | undefined;
  /** Mesh, when it is running: an agent id to its registered manifest and home. */
  mesh: () =>
    | {
        get(agentId: string): { name: string; displayName?: string } | undefined;
        getProjectPath(agentId: string): string | undefined;
      }
    | undefined;
  /** The clock, for how long a comment waits for Allow. A test pins it. */
  now?: () => number;
}

/** One forward to send: everything already checked by the route. */
export interface ForwardRequest {
  /** The mini app. */
  extensionId: string;
  /** Its manifest name. */
  appName: string;
  /** The person, resolved by a route that ran the forward bar. */
  viewer: AuthorRecord;
  /** Exactly what they typed. */
  text: string;
  /** The app's id for the item. */
  itemId: string;
  /** The app's title for the item, when it sent one. */
  itemTitle?: string;
  /** The agent the app asked for. Reached only when it is on the person's list. */
  agentId?: string;
  /** The Wi-Fi hold, as a person's own post from Wi-Fi gets (DOR-3037). */
  bound?: PersonPostBound;
  /** The app window that sent it (`X-Client-Id`); a held comment is allowed only from it. */
  clientId?: string;
}

/** A comment waiting for the person's Allow, as the core prompt reads it. */
export interface PendingForward {
  /** Its id, for the Allow. Single use. */
  id: string;
  /**
   * The agent the prompt asks about: its display name, and the handle it was
   * registered under, which an agent cannot change about itself. The prompt
   * shows both, so a renamed agent cannot pass for another.
   */
  agent: { id: string; name: string; handle: string };
  /** The mini app's name. */
  appName: string;
}

/** A registered agent, named as the registry names it. */
interface NamedAgent {
  id: string;
  name: string;
  /** The registered name, which the agent cannot change about itself. */
  handle: string;
}

/** The agent a mini app forwards to, resolved to its Direct chat. */
interface ResolvedAgent extends NamedAgent {
  roomId: string;
  agentAuthorId: string;
}

/** A held comment: the request exactly as the route parsed it, and when it lapses. */
interface HeldForward {
  request: ForwardRequest & { agentId: string };
  expiresAt: number;
}

/** Forwards and their answers. See the module documentation. */
export class PersonForwards {
  private readonly held = new Map<string, HeldForward>();
  private readonly now: () => number;

  constructor(private readonly deps: PersonForwardDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * A registered agent's id and registered name, or undefined when Mesh does
   * not know it. Never a name from a manifest or a request.
   *
   * @param agentId - The agent.
   * @throws {PersonForwardError} `unavailable` while Mesh is not running.
   */
  registered(agentId: string): NamedAgent | undefined {
    const mesh = this.deps.mesh();
    if (!mesh) throw new PersonForwardError('unavailable', 'Agents aren’t loaded yet. Try again.');
    const manifest = mesh.get(agentId);
    return manifest
      ? { id: agentId, name: manifest.displayName ?? manifest.name, handle: manifest.name }
      : undefined;
  }

  /**
   * The agents the person allowed for a mini app, and the ids on the list
   * Mesh no longer knows.
   *
   * @param extensionId - The mini app.
   */
  agents(extensionId: string): { agents: NamedAgent[]; missing: string[] } {
    const agents: NamedAgent[] = [];
    const missing: string[] = [];
    for (const id of forwardAgentsOf(extensionId)) {
      const agent = this.registered(id);
      if (agent) agents.push(agent);
      else missing.push(id);
    }
    return { agents, missing };
  }

  /**
   * Post the person's words into their Direct chat with an allowed agent.
   *
   * @param request - The forward.
   * @returns The receipt.
   * @throws {PersonForwardError} `no_agent` when the agent is not allowed
   *   (with `suggestedAgentId` when the request named a registered one),
   *   `not_found` when it is gone, `invalid_input` when the list has several
   *   and none was named, `unavailable` when rooms or Mesh are not running.
   */
  forward(request: ForwardRequest): ForwardReceipt {
    const agent = this.resolve(this.targetOf(request));
    const rooms = this.deps.rooms();
    if (!rooms) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    const appName = sanitizeIdentity(request.appName) ?? request.extensionId;
    const title =
      request.itemTitle !== undefined ? sanitizeIdentity(request.itemTitle, 200) : undefined;
    const via: ForwardVia = {
      extensionId: request.extensionId,
      appName,
      itemId: request.itemId,
      ...(title ? { itemTitle: title } : {}),
    };
    // A person's own post, with no marks: the agent's turn is held to what the
    // person's own typing would be, and from Wi-Fi to the same default.
    const posted = rooms.post(
      agent.roomId,
      { authorId: request.viewer.id, text: request.text, via },
      false,
      request.bound
    );
    return { id: posted.id, agent: { id: agent.id, name: agent.name }, sentAt: posted.createdAt };
  }

  /**
   * Keep a refused comment for the person's Allow on the core prompt.
   *
   * @param request - The forward the route parsed from the person's POST.
   * @param agentId - The registered agent the request named.
   * @returns What the prompt shows.
   * @throws {PersonForwardError} `not_found` when the agent is not registered.
   */
  hold(request: ForwardRequest, agentId: string): PendingForward {
    const agent = this.registered(agentId);
    if (!agent) throw new PersonForwardError('not_found', 'There is no agent with that id here.');
    this.prune();
    // Bounded: a page that forwards in a loop must not grow this forever.
    while (this.held.size >= PENDING_FORWARDS_MAX) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
    const id = crypto.randomUUID();
    this.held.set(id, {
      request: { ...request, agentId },
      expiresAt: this.now() + PENDING_FORWARD_TTL_MS,
    });
    return {
      id,
      agent,
      appName: sanitizeIdentity(request.appName) ?? request.extensionId,
    };
  }

  /**
   * The person allowed the agent on the core prompt: add it to the mini app's
   * list and send the comment DorkOS kept. Single use.
   *
   * @param extensionId - The mini app the Allow came through.
   * @param viewer - The person, resolved by a route that ran the forward bar.
   * @param pendingId - The held comment.
   * @param clientId - The app window asking (`X-Client-Id`). Only the window
   *   that sent the comment may allow it.
   * @returns The receipt, and the item the comment was on, for the audit row.
   * @throws {PersonForwardError} `not_found` when nothing is held under that
   *   id for this mini app, person and window, it lapsed, or the agent is gone.
   */
  allow(
    extensionId: string,
    viewer: AuthorRecord,
    pendingId: string,
    clientId: string
  ): ForwardReceipt & { itemId: string } {
    this.prune();
    const held = this.held.get(pendingId);
    if (!this.isHeldFor(held, extensionId, viewer, clientId)) {
      throw new PersonForwardError(
        'not_found',
        'That comment is no longer waiting. Send it again.'
      );
    }
    this.held.delete(pendingId);
    const { agentId } = held.request;
    if (!this.registered(agentId)) {
      throw new PersonForwardError('not_found', 'That agent is gone. Nothing was sent.');
    }
    setForwardAgents(extensionId, [...forwardAgentsOf(extensionId), agentId]);
    return { ...this.forward(held.request), itemId: held.request.itemId };
  }

  /** Whether a held comment is this mini app's, this person's, from this window. */
  private isHeldFor(
    held: HeldForward | undefined,
    extensionId: string,
    viewer: AuthorRecord,
    clientId: string
  ): held is HeldForward {
    return (
      held !== undefined &&
      held.request.extensionId === extensionId &&
      held.request.viewer.id === viewer.id &&
      held.request.clientId === clientId
    );
  }

  /**
   * The person said no on the core prompt: drop the held comment.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param pendingId - The held comment.
   * @param clientId - The app window asking.
   */
  decline(extensionId: string, viewer: AuthorRecord, pendingId: string, clientId: string): void {
    if (this.isHeldFor(this.held.get(pendingId), extensionId, viewer, clientId)) {
      this.held.delete(pendingId);
    }
  }

  /**
   * The agent's answers to one of this mini app's forwards, oldest first.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param forwardId - The forward's id.
   * @throws {PersonForwardError} `not_found` when it is not this mini app's
   *   forward in the Direct chat of an agent on its list.
   */
  replies(extensionId: string, viewer: AuthorRecord, forwardId: string): ForwardReply[] {
    const rooms = this.deps.rooms();
    if (!rooms) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    for (const id of forwardAgentsOf(extensionId)) {
      let agent: ResolvedAgent;
      try {
        agent = this.resolve(id);
      } catch {
        continue;
      }
      const forward = rooms.readEntry(agent.roomId, viewer.id, forwardId);
      if (!forward || forward.body.via?.extensionId !== extensionId) continue;
      return rooms
        .entriesAfter(agent.roomId, forward.seq)
        .filter(
          (entry) =>
            entry.kind === 'post' &&
            entry.authorId === agent.agentAuthorId &&
            entry.body.answersEntryId === forwardId
        )
        .slice(0, FORWARD_REPLIES_MAX)
        .map((entry) => ({
          id: entry.id,
          agent: { id: agent.id, name: agent.name },
          markdown: defuseReplyMarkdown(entry.body.text),
          createdAt: entry.createdAt,
        }));
    }
    throw new PersonForwardError('not_found', 'This mini app sent no such comment.');
  }

  /**
   * DorkOS's own record of who wrote each of this mini app's forwards: the
   * room entry it posted, read back. Only an entry carrying this mini app's
   * `via` and authored by the person asking gets a stamp; an id the app made
   * up, a comment typed by hand in the chat, or another person's post gets
   * none. No door but the forward route writes `via` (`room-posting.ts`).
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param forwardIds - The ids to look up.
   */
  stamps(
    extensionId: string,
    viewer: AuthorRecord,
    forwardIds: readonly string[]
  ): Record<string, ForwardStamp> {
    const rooms = this.deps.rooms();
    if (!rooms) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    const wanted = new Set(forwardIds);
    const out: Record<string, ForwardStamp> = {};
    for (const agentId of forwardAgentsOf(extensionId)) {
      let agent: ResolvedAgent;
      try {
        agent = this.resolve(agentId);
      } catch {
        continue;
      }
      for (const id of wanted) {
        const entry = rooms.readEntry(agent.roomId, viewer.id, id);
        if (!entry || entry.authorId !== viewer.id) continue;
        if (entry.body.via?.extensionId !== extensionId) continue;
        out[id] = {
          id,
          author: { kind: 'person', name: viewer.displayName || 'You', isYou: true },
          agent: { id: agent.id, name: agent.name },
          itemId: entry.body.via.itemId,
          sentAt: entry.createdAt,
        };
        wanted.delete(id);
      }
    }
    return out;
  }

  /** The allowed agent a forward goes to, or the refusal. */
  private targetOf(request: ForwardRequest): string {
    const allowed = forwardAgentsOf(request.extensionId);
    if (request.agentId !== undefined) {
      if (allowed.includes(request.agentId)) return request.agentId;
      const suggested = this.registered(request.agentId);
      if (!suggested)
        throw new PersonForwardError('not_found', 'There is no agent with that id here.');
      throw new PersonForwardError(
        'no_agent',
        `You haven’t allowed this mini app to send your comments to ${suggested.name}.`,
        suggested.id
      );
    }
    if (allowed.length === 1) return allowed[0]!;
    if (allowed.length === 0) {
      throw new PersonForwardError(
        'no_agent',
        'Pick an agent for this mini app in Settings → Extensions first.'
      );
    }
    throw new PersonForwardError('invalid_input', 'Say which agent with agentId.');
  }

  /** An agent and its Direct chat, or the refusal. */
  private resolve(agentId: string): ResolvedAgent {
    const picked = this.registered(agentId);
    const path = picked ? this.deps.mesh()?.getProjectPath(agentId) : undefined;
    if (!picked || !path) {
      throw new PersonForwardError(
        'not_found',
        'That agent is gone. Pick another in Settings → Extensions.'
      );
    }
    const chats = this.deps.directChats();
    if (!chats) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    const chat = chats.ensureForAgent(path, picked.name);
    return { ...picked, roomId: chat.roomId, agentAuthorId: chat.agentAuthorId };
  }

  /** Drop held comments that lapsed. */
  private prune(): void {
    const now = this.now();
    for (const [id, held] of this.held) if (held.expiresAt <= now) this.held.delete(id);
  }
}
