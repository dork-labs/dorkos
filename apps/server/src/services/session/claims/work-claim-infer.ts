/**
 * The work a `session_start` is about, read off its brief when the caller named
 * no `claim` (DOR-3690). An agent that starts a second spin-off for a ticket one
 * of its chats already has gets that chat back instead, and the check only
 * works when the start carries a key, so a brief that plainly names one ticket
 * or pull request is read as claiming it.
 *
 * Deliberately narrow, because a wrong key sends a start to an unrelated chat:
 *
 * - **Ticket ids** in tracker form, upper-case prefix and a number (`DOR-1234`).
 *   Common names that share the shape (`SHA-256`, `UTF-8`, `ISO-8601`) are not.
 * - **Pull requests** only when the text says so: `PR #42`, `PR 42`, a
 *   `…/pull/42` link (all `PR #42`), or a repo-qualified `owner/repo#42`. A bare
 *   `#42` could be an issue, a heading or a colour, so it is never read as one.
 * - **Exactly one.** The title and reason are read first, the first message
 *   only when they name nothing. Two different keys in the text read is
 *   ambiguous, and nothing is inferred.
 *
 * @module services/session/claims/work-claim-infer
 */
import { normaliseClaimKey } from './work-claim-service.js';

/** Tracker-shaped words that are not tickets. */
const NOT_TICKETS = new Set(['AES', 'CVE', 'GPT', 'ISO', 'RFC', 'RSA', 'SHA', 'SSL', 'TLS', 'UTF']);

const TICKET = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
const PULL = /\bPR\s*#?(\d{1,7})\b|\/pull\/(\d{1,7})\b/gi;
const QUALIFIED = /\b([\w.-]+\/[\w.-]+)#(\d{1,7})\b/g;

/** Every work key one piece of text names, normalised. */
function keysIn(text: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (!text) return keys;
  const add = (raw: string) => {
    const key = normaliseClaimKey(raw);
    if (key) keys.add(key);
  };
  for (const [, prefix, number] of text.matchAll(TICKET)) {
    if (!NOT_TICKETS.has(prefix!)) add(`${prefix}-${number}`);
  }
  for (const [, pr, pull] of text.matchAll(PULL)) add(`PR #${pr ?? pull}`);
  for (const [, repo, number] of text.matchAll(QUALIFIED)) add(`${repo}#${number}`);
  return keys;
}

/** The one key in `keys`, or `null` for none or several. */
function onlyKey(keys: Set<string>): string | null {
  return keys.size === 1 ? [...keys][0]! : null;
}

/**
 * The one ticket or pull request a start's brief names, or `null`.
 *
 * @param brief - The start's title, reason and first message.
 * @returns The normalised key, or `null` when the brief names none or more than one.
 */
export function inferClaimKey(brief: {
  title?: string;
  reason?: string;
  prompt?: string;
}): string | null {
  const named = keysIn(`${brief.title ?? ''}\n${brief.reason ?? ''}`);
  if (named.size > 0) return onlyKey(named);
  return onlyKey(keysIn(brief.prompt));
}
