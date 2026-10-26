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
 * 1. **The agent is the person's pick, never the request's.** One agent per
 *    mini app, chosen in Settings → Extensions (`extensions.forwardAgent`,
 *    `operator-only`). A forward with none picked is refused.
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
import type { ForwardErrorCode, ForwardReceipt, ForwardReply } from '@dorkos/extension-api';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import type { AuthorRecord } from '../../rooms/index.js';
import type { PersonPostBound } from '../../rooms/messages/room-entry-writer.js';

/** Most answers {@link PersonForwards.replies} returns for one forward. */
export const FORWARD_REPLIES_MAX = 20;

/** A forward refused, with nothing posted. */
export class PersonForwardError extends Error {
  /**
   * Refuse a forward.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   */
  constructor(
    readonly code: ForwardErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PersonForwardError';
  }
}

/**
 * The agent a person picked for one mini app, by Mesh id, or undefined.
 * Read per call, so a change takes effect on the next forward.
 *
 * @param extensionId - The mini app.
 */
export function forwardAgentOf(extensionId: string): string | undefined {
  return configManager.get('extensions')?.forwardAgent?.[extensionId];
}

/**
 * Set or clear the agent one mini app forwards to. Only
 * `PUT /api/extensions/:id/forward-agent` calls this, behind the person bar.
 * Spreads the whole `extensions` section, because the store write replaces the
 * subtree and naming only this key would erase every approval beside it.
 *
 * @param extensionId - The mini app.
 * @param agentId - The agent, or null for none.
 */
export function setForwardAgent(extensionId: string, agentId: string | null): void {
  const before = configManager.get('extensions');
  const next = { ...(before?.forwardAgent ?? {}) };
  if (agentId === null) delete next[extensionId];
  else next[extensionId] = agentId;
  configManager.set('extensions', { ...before, forwardAgent: next });
  logConfigWrite(
    'choosing the agent a mini app forwards to',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

/**
 * Agent markdown with no way to become HTML: every `<` escaped, and a link
 * or image whose target is a script or data URL left as plain text. The
 * mini app renders it as markdown; this keeps an agent's answer from being
 * markup in a page that runs as the person.
 *
 * @param text - The agent's post.
 */
export function defuseReplyMarkdown(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/\]\(\s*(?:javascript|vbscript|data):(?:[^()]|\([^()]*\))*\)/giu, '](#)');
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
  /** Mesh, when it is running: an agent id to its manifest and home. */
  mesh: () =>
    | {
        get(agentId: string): { name: string; displayName?: string } | undefined;
        getProjectPath(agentId: string): string | undefined;
      }
    | undefined;
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
  /** The Wi-Fi hold, as a person's own post from Wi-Fi gets (DOR-3037). */
  bound?: PersonPostBound;
}

/** The agent a mini app forwards to, resolved. */
interface ResolvedAgent {
  id: string;
  name: string;
  roomId: string;
  agentAuthorId: string;
}

/** Forwards and their answers. See the module documentation. */
export class PersonForwards {
  constructor(private readonly deps: PersonForwardDeps) {}

  /**
   * The agent the person picked for a mini app, or null when none is picked.
   *
   * @param extensionId - The mini app.
   * @throws {PersonForwardError} `not_found` when the picked agent is gone.
   */
  agent(extensionId: string): { id: string; name: string } | null {
    const id = forwardAgentOf(extensionId);
    if (id === undefined) return null;
    const mesh = this.deps.mesh();
    if (!mesh) throw new PersonForwardError('unavailable', 'Agents aren’t loaded yet. Try again.');
    const manifest = mesh.get(id);
    if (!manifest) {
      throw new PersonForwardError(
        'not_found',
        'The agent picked for this mini app is gone. Pick another in Settings → Extensions.'
      );
    }
    return { id, name: manifest.displayName ?? manifest.name };
  }

  /**
   * Post the person's words into their Direct chat with the picked agent.
   *
   * @param request - The forward.
   * @returns The receipt.
   * @throws {PersonForwardError} When no agent is picked, it is gone, or rooms are not running.
   */
  forward(request: ForwardRequest): ForwardReceipt {
    const agent = this.resolve(request.extensionId);
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
   * The agent's answers to one of this mini app's forwards, oldest first.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param forwardId - The forward's id.
   * @throws {PersonForwardError} `not_found` when it is not this mini app's
   *   forward in the picked agent's Direct chat.
   */
  replies(extensionId: string, viewer: AuthorRecord, forwardId: string): ForwardReply[] {
    const agent = this.resolve(extensionId);
    const rooms = this.deps.rooms();
    if (!rooms) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    const forward = rooms.readEntry(agent.roomId, viewer.id, forwardId);
    if (!forward || forward.body.via?.extensionId !== extensionId) {
      throw new PersonForwardError('not_found', 'This mini app sent no such comment.');
    }
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

  /** The picked agent and its Direct chat, or the refusal. */
  private resolve(extensionId: string): ResolvedAgent {
    const picked = this.agent(extensionId);
    if (!picked) {
      throw new PersonForwardError(
        'no_agent',
        'Pick an agent for this mini app in Settings → Extensions first.'
      );
    }
    const path = this.deps.mesh()?.getProjectPath(picked.id);
    const chats = this.deps.directChats();
    if (!path) {
      throw new PersonForwardError(
        'not_found',
        'The agent picked for this mini app is gone. Pick another in Settings → Extensions.'
      );
    }
    if (!chats) throw new PersonForwardError('unavailable', 'Rooms aren’t running. Try again.');
    const chat = chats.ensureForAgent(path, picked.name);
    return { ...picked, roomId: chat.roomId, agentAuthorId: chat.agentAuthorId };
  }
}
