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
 * - **Pull requests** only when the text says so: `PR #42` or `PR 42`
 *   (`PR #42`), or one that names its repo, `owner/repo#42` or a
 *   `…/owner/repo/pull/42` link (`OWNER/REPO#42`, so two repos' #42 never
 *   collide). A bare `#42` could be an issue, a heading or a colour, so it is
 *   never read as one.
 * - **Exactly one.** The title and reason are read first, the first message
 *   only when they name nothing, and the answer says which it came from: a
 *   brief often names the work it relates to rather than the work it is.
 *   Two different keys in the text read is ambiguous, and nothing is inferred.
 *
 * @module services/session/claims/work-claim-infer
 */
import { normaliseClaimKey } from './work-claim-service.js';

/** Tracker-shaped words that are not tickets. */
const NOT_TICKETS = new Set(['AES', 'CVE', 'GPT', 'ISO', 'RFC', 'RSA', 'SHA', 'SSL', 'TLS', 'UTF']);

const TICKET = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
const PULL = /\bPR\s*#?(\d{1,7})\b/gi;
const PULL_LINK = /([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b|(?<![\w.-])\/pull\/(\d{1,7})\b/g;
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
  for (const [, pr] of text.matchAll(PULL)) add(`PR #${pr}`);
  for (const [, repo, number, bare] of text.matchAll(PULL_LINK)) {
    add(repo ? `${repo}#${number}` : `PR #${bare}`);
  }
  for (const [, repo, number] of text.matchAll(QUALIFIED)) add(`${repo}#${number}`);
  return keys;
}

/** The one key in `keys`, or `null` for none or several. */
function onlyKey(keys: Set<string>): string | null {
  return keys.size === 1 ? [...keys][0]! : null;
}

/** A key read off a brief, and where: the title or reason, or only the first message. */
export interface InferredWorkKey {
  /** The normalised key. */
  key: string;
  /** `brief` for the title or reason, `prompt` for the first message alone. */
  from: 'brief' | 'prompt';
}

/**
 * The one ticket or pull request a start's brief names, and where it was read.
 *
 * @param brief - The start's title, reason and first message.
 * @returns The key and its source, or `null` when the brief names none or more than one.
 */
export function inferWorkKey(brief: {
  title?: string;
  reason?: string;
  prompt?: string;
}): InferredWorkKey | null {
  const named = keysIn(`${brief.title ?? ''}\n${brief.reason ?? ''}`);
  if (named.size > 0) {
    const key = onlyKey(named);
    return key ? { key, from: 'brief' } : null;
  }
  const key = onlyKey(keysIn(brief.prompt));
  return key ? { key, from: 'prompt' } : null;
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
  return inferWorkKey(brief)?.key ?? null;
}
