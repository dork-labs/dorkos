/**
 * Which chat each minted identity token was minted for (DOR-5264), so a script
 * a chat runs can say what that chat did without ever naming the chat: the
 * server reads it off the token the chat's own process carries.
 *
 * ## In memory only, and why that is enough
 *
 * The map holds a token's digest and the chat it was minted for, never the
 * token. A restart empties it, and so does nothing worse than refuse: a token
 * with no entry names no chat, and a capability that needs one refuses the
 * call. It never falls back to another chat.
 *
 * ## How long an entry lives
 *
 * A launch mints a token per dispatch, but a warm Claude Code process keeps the
 * one from its first launch for every later turn (the launch fingerprint pins
 * the identity, not the token). So an entry lives while the process that holds
 * the token can: until the chat's process is disposed, the chat is removed, its
 * agent's tokens are revoked, the server restarts, or the map is full and it is
 * the oldest. An entry is not a pass on its own: the one reader,
 * `work-graph.record-pr`, also needs a live run of that chat right now.
 *
 * No launch knows its run id yet, so an entry names a chat. C18 (DOR-5278,
 * spec `computer-side-starts-alone` §5.3) makes it a token per run, gone when
 * the run ends, for every runtime.
 *
 * @module services/core/agent-identity/token-chats
 */

/** The most entries kept; past it the oldest goes first. */
export const TOKEN_CHAT_LIMIT = 4096;

/** What one entry says. */
interface TokenChat {
  /** The chat the token was minted for. */
  chatId: string;
  /** The agent it was minted for, so revoking the agent drops it. */
  agentPath: string;
}

/** Token digest → the chat it was minted for, oldest first. */
export class TokenChats {
  private readonly entries = new Map<string, TokenChat>();

  /**
   * Build an empty map.
   *
   * @param limit - The most entries kept.
   */
  constructor(private readonly limit = TOKEN_CHAT_LIMIT) {}

  /**
   * Remember the chat a token was minted for.
   *
   * @param tokenHash - The token's stored digest.
   * @param chatId - The chat its process runs.
   * @param agentPath - The agent it names.
   */
  bind(tokenHash: string, chatId: string, agentPath: string): void {
    this.entries.delete(tokenHash);
    this.entries.set(tokenHash, { chatId, agentPath });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * The chat a token was minted for, or `undefined` when no entry holds it.
   *
   * @param tokenHash - The presented token's digest.
   */
  chatOf(tokenHash: string): string | undefined {
    return this.entries.get(tokenHash)?.chatId;
  }

  /**
   * Drop every entry for these chats: their process was disposed or the chat is gone.
   *
   * @param chatIds - Every id the chat is known by.
   */
  forgetChat(chatIds: readonly string[]): void {
    const ids = new Set(chatIds);
    for (const [hash, entry] of this.entries) if (ids.has(entry.chatId)) this.entries.delete(hash);
  }

  /**
   * Drop every entry for an agent whose tokens were revoked.
   *
   * @param agentPath - The agent.
   */
  forgetAgent(agentPath: string): void {
    for (const [hash, entry] of this.entries)
      if (entry.agentPath === agentPath) this.entries.delete(hash);
  }
}
