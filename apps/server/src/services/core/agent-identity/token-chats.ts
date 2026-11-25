/**
 * Which chat each identity token's process runs (DOR-5264), so a script a chat
 * runs can say what that chat did without ever naming the chat: the server
 * reads it off the token the chat's own process carries.
 *
 * ## In memory only, and why that is enough
 *
 * The map holds a token's digest and the chat its process runs, never the
 * token. A restart empties it, and so does nothing worse than refuse: a token
 * with no entry names no chat, and a capability that needs one refuses the
 * call. It never falls back to another chat.
 *
 * ## How long an entry lives
 *
 * A token is entered when a process that holds it starts (Claude Code at its
 * spawn, Codex when a thread loads with it), never when it is minted: a launch
 * mints one per dispatch, and a warm process keeps the one it started with, so
 * a token minted for a turn that rode a warm process reaches no process and is
 * never entered. Each process that holds a token counts once, because a crash
 * recovery boots a new process on the same token, and the entry goes when the
 * last of them ends: an old process's late exit never takes a newer one's
 * entry. Past {@link TOKEN_CHAT_LIMIT} the least recently used entry goes
 * first, and reading one counts as use. A restart empties the map.
 *
 * A token held for a second chat while the first still holds it is
 * conflicted: it names no chat until every holder has let it go. Tokens are
 * minted per launch, so this should never happen; it fails closed if it does.
 *
 * An entry is not a pass on its own: the one reader, `work-graph.record-pr`,
 * also needs a live run of that chat right now, and a revoked token names no
 * chat at all. No launch knows its run id yet, so an entry names a chat. C18
 * (DOR-5278, spec `computer-side-starts-alone` §5.3) makes it a token per run,
 * gone when the run ends, for every runtime.
 *
 * @module services/core/agent-identity/token-chats
 */

/** The most entries kept; past it the least recently used goes first. */
export const TOKEN_CHAT_LIMIT = 4096;

/** What one entry says. */
interface TokenChat {
  /** The chat the token's processes run. */
  chatId: string;
  /** How many live processes hold the token. */
  holders: number;
  /**
   * The token was held for two different chats. It then names no chat until
   * every holder has let it go, so no process can record to a chat it does
   * not run.
   */
  conflicted?: true;
}

/** Token digest → the chat its processes run, least recently used first. */
export class TokenChats {
  private readonly entries = new Map<string, TokenChat>();

  /**
   * Build an empty map.
   *
   * @param limit - The most entries kept.
   */
  constructor(private readonly limit = TOKEN_CHAT_LIMIT) {}

  /** How many tokens name a chat right now. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * A process holding the token has started, for this chat.
   *
   * @param tokenHash - The token's stored digest.
   * @param chatId - The chat the process runs.
   */
  hold(tokenHash: string, chatId: string): void {
    const held = this.entries.get(tokenHash);
    this.entries.delete(tokenHash);
    this.entries.set(
      tokenHash,
      held === undefined
        ? { chatId, holders: 1 }
        : {
            chatId: held.chatId,
            holders: held.holders + 1,
            ...(held.conflicted || held.chatId !== chatId ? { conflicted: true as const } : {}),
          }
    );
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * The chat a token's processes run, or `undefined` when no entry holds it
   * or it was held for two chats. A read counts as use, so live tokens are the
   * last to go.
   *
   * @param tokenHash - The presented token's digest.
   */
  chatOf(tokenHash: string): string | undefined {
    const entry = this.entries.get(tokenHash);
    if (entry === undefined) return undefined;
    this.entries.delete(tokenHash);
    this.entries.set(tokenHash, entry);
    return entry.conflicted ? undefined : entry.chatId;
  }

  /**
   * A process holding each of these tokens has ended; an entry goes with its last holder.
   *
   * @param tokenHashes - The tokens' stored digests.
   */
  release(tokenHashes: readonly string[]): void {
    for (const hash of tokenHashes) {
      const entry = this.entries.get(hash);
      if (entry === undefined) continue;
      if (entry.holders > 1) entry.holders -= 1;
      else this.entries.delete(hash);
    }
  }
}
