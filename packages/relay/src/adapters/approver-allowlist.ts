/**
 * Who may authorize a tool call that arrived from a chat platform.
 *
 * ## The defect this exists for (DOR-609, found under DOR-604)
 *
 * When an agent turn driven from Slack or Telegram needs approval, DorkOS
 * forwards an approval card — with Approve and Deny buttons — into the very
 * conversation that asked for the turn. Both adapters then read the clicking
 * user's id into a `respondedBy` field and published the approval.
 *
 * `respondedBy` is a **record of who acted**, and it was standing in for a
 * **decision about who may**. Nothing checked it. So the person who sent the
 * message that triggered the tool call could approve their own tool call, from
 * their own device, with one tap. Closing the runtime's permission gate (DOR-604)
 * turns a zero-click shell command into a one-click one; it is this list that
 * makes the click mean something.
 *
 * ## Why it is its own list
 *
 * Deliberately **not** `dmAllowlist`, and deliberately not derived from it.
 * Being allowed to talk to an agent and being allowed to authorize a shell
 * command on the operator's machine are different privileges. Folding them
 * together would silently hand the second to everyone who has the first, which
 * is the same "absence is consent" mistake one layer up.
 *
 * It also gates more than DMs. `dmPolicy` only ever applied to direct messages
 * (`slack/inbound.ts` checks it under `isDm`); anyone who can post in a channel
 * the bot sits in was never filtered by it at all, and the approval card lands
 * in that channel. So this list — not `dmPolicy` — is the control that covers
 * both ways in.
 *
 * ## Empty means nobody
 *
 * The default is an empty list, and an empty list authorizes no one. A missing,
 * malformed, or empty allowlist is never read as "anyone may": absence is not
 * consent. An operator who wants approvals from chat names the people who may
 * give them.
 *
 * @module adapters/approver-allowlist
 */

/**
 * Read an id list from config, tolerating the shape the setup form produces.
 *
 * A textarea field arrives as one id per line rather than an array (the same
 * coercion `dmAllowlist` needs), and a value that is neither is treated as an
 * empty list rather than guessed at.
 *
 * @param value - The raw config value.
 * @returns The ids, trimmed and empty-filtered.
 */
export function toIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Whether this platform user may authorize a tool call.
 *
 * Fails closed on every uncertainty — no allowlist, an empty one, or an
 * unidentified caller all return `false`.
 *
 * @param allowlist - Configured approver ids, in whatever shape config held them.
 * @param userId - The platform user id that clicked, if the platform gave one.
 * @returns `true` only when the caller is named in a non-empty allowlist.
 */
export function mayApprove(allowlist: unknown, userId: string | undefined): boolean {
  if (!userId) return false;
  const approvers = toIdList(allowlist);
  if (approvers.length === 0) return false;
  return approvers.includes(userId);
}
