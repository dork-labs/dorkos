/**
 * Who writes doc comments, who can be mentioned in them, and how much their
 * words count for (DOR-2983).
 *
 * Authors are room authors (`services/rooms/author-registry.ts`): an agent or
 * a person has one identity, one handle and one avatar whether they write in
 * a room or on a doc, and a mention resolves by the same grammar
 * (`services/rooms/mentions.ts`).
 *
 * ## Trust
 *
 * Only the owner's own comments are instructions. Everybody else's words are
 * information:
 *
 * - `owner`: the person who owns this computer (`isOwnerRecord`), and only
 *   when the request cleared the person bars (`routes/doc-comment-caller.ts`).
 * - `agent`: one of this computer's agents. A teammate, but not the owner, so
 *   its words are framed as a colleague's information, and the turn it starts
 *   is held to the agent's own level.
 * - `outsider`: any other author, which includes a person this computer
 *   cannot vouch for and the owner's author on a request that did not prove a
 *   person. Its turn is held to the runtime's default.
 *
 * @module services/docs/comments/comment-directory
 */
import type { MeshCore } from '@dorkos/mesh';
import type { DocCommentAuthor, DocCommentMentionable } from '@dorkos/shared/doc-comments';
import {
  isOwnerRecord,
  type AuthorRecord,
  type AuthorRegistry,
} from '../../rooms/author-registry.js';
import type { MentionCandidate } from '../../rooms/mentions.js';

/** How much one author's words count for. See the module documentation. */
export type CommentTrust = 'owner' | 'agent' | 'outsider';

/** The agent behind an agent author: what a wake needs to start its turn. */
export interface CommentAgent {
  /** The Mesh agent id. */
  agentId: string;
  /** The agent's home. */
  agentPath: string;
  /** Its name, for the words a notification uses. */
  name: string;
}

/** The author registry calls this module reads. */
export type CommentAuthorRegistry = Pick<AuthorRegistry, 'getMany' | 'resolveAgent' | 'listActive'>;

/** What the directory reads. Every member is read at call time. */
export interface CommentDirectoryDeps {
  /** The room author registry. */
  authors: () => CommentAuthorRegistry;
  /** The owner account's user id, or `null` when the install has no accounts. */
  ownerUserId: () => string | null;
  /** Mesh, when it is running. */
  meshCore: () => Pick<MeshCore, 'listWithPaths' | 'getByPath'> | undefined;
}

/** Authors, the mention roster and trust, for the comment service. */
export class CommentDirectory {
  /**
   * Build the directory.
   *
   * @param deps - What it reads.
   */
  constructor(private readonly deps: CommentDirectoryDeps) {}

  /**
   * How a reader sees each author.
   *
   * @param ids - Author ids.
   * @returns Each author found, by id. An author with no row is left out.
   */
  describe(ids: readonly string[]): Map<string, DocCommentAuthor> {
    const owner = this.deps.ownerUserId();
    const records = this.deps.authors().getMany(ids);
    const described = new Map<string, DocCommentAuthor>();
    for (const [id, record] of records) described.set(id, toAuthor(record, owner));
    return described;
  }

  /**
   * The author rows behind some ids.
   *
   * @param ids - Author ids.
   * @returns Each author found, by id.
   */
  records(ids: readonly string[]): Map<string, AuthorRecord> {
    return this.deps.authors().getMany(ids);
  }

  /**
   * How much an author's words count for.
   *
   * @param author - The author.
   * @param inPerson - Whether the request was the owner in person. The owner's
   *   author without it is an outsider: resolving to the owner is not proof.
   */
  trustOf(author: AuthorRecord, inPerson: boolean): CommentTrust {
    if (isOwnerRecord(author, this.deps.ownerUserId())) return inPerson ? 'owner' : 'outsider';
    if (author.kind === 'agent' && this.agentOf(author) !== null) return 'agent';
    return 'outsider';
  }

  /**
   * The registered agent an author speaks for, or null when it is not one.
   *
   * @param author - The author.
   */
  agentOf(author: AuthorRecord): CommentAgent | null {
    if (author.kind !== 'agent') return null;
    const manifest = this.deps.meshCore()?.getByPath(author.naturalKey);
    if (!manifest) return null;
    return {
      agentId: manifest.id,
      agentPath: author.naturalKey,
      name: manifest.displayName || manifest.name || author.displayName,
    };
  }

  /**
   * The author an agent writes as, minted on first use.
   *
   * @param agentPath - The agent's home, from its verified identity.
   * @returns The author, or null when no registered agent lives there.
   */
  agentAuthor(agentPath: string): AuthorRecord | null {
    const manifest = this.deps.meshCore()?.getByPath(agentPath);
    if (!manifest) return null;
    return this.deps.authors().resolveAgent(agentPath, manifest.displayName || manifest.name);
  }

  /**
   * Everybody a comment can mention: every registered agent, and the owner
   * once they have chosen a handle.
   *
   * Agents are resolved through the author registry, which mints an author
   * for an agent that has never written anywhere, so a fresh agent is
   * mentionable on its first day.
   *
   * @returns The roster, agents first, then people, each by name.
   */
  mentionable(): DocCommentMentionable[] {
    const owner = this.deps.ownerUserId();
    const registry = this.deps.authors();
    const agents = (this.deps.meshCore()?.listWithPaths() ?? []).map((agent) =>
      registry.resolveAgent(agent.projectPath, agent.displayName || agent.name)
    );
    const people = registry.listActive('human').filter((record) => isOwnerRecord(record, owner));
    const byName = (a: DocCommentAuthor, b: DocCommentAuthor) =>
      a.displayName.localeCompare(b.displayName);
    const roster = (records: AuthorRecord[]) =>
      records
        .map((record) => toAuthor(record, owner))
        .filter((author): author is DocCommentMentionable => author.handle !== null)
        .sort(byName);
    return [...roster(agents), ...roster(people)];
  }

  /**
   * The roster a comment's `@handles` resolve against, in the form the room
   * mention resolver takes.
   */
  mentionCandidates(): MentionCandidate[] {
    return this.mentionable().map((author) => ({ authorId: author.id, names: [author.handle] }));
  }
}

/** One author as a reader sees them. */
function toAuthor(record: AuthorRecord, ownerUserId: string | null): DocCommentAuthor {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    handle: record.handle,
    emoji: record.emoji,
    color: record.color,
    isOwner: isOwnerRecord(record, ownerUserId),
  };
}
