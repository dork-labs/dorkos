/**
 * What counts as a secret in a connected-app action's arguments, for its
 * approval card (DOR-2504).
 *
 * Stricter than the sweep every approval card gets (`redactSecretsInText`),
 * and deliberately scoped to connected-app argument values only. A shell
 * command, a file path or a hook card has to show text like `task-runner`,
 * `Basic settings` or a long file id exactly, and a sweep tuned for API
 * payloads would hide it there. Here the values are what an agent is about to
 * send to someone else's service, where a pasted key is the likelier thing.
 *
 * Every pattern is anchored so it fires on the credential itself, not on a
 * word that happens to contain its prefix: `sk-` must not follow a letter or
 * digit (so `task-runner` and `desk-booking` stay readable), `Bearer` and
 * `Basic` are case-sensitive and need an `Authorization:` before them or a
 * credential-shaped value after, and the long-run rule leaves out `_` and `-`
 * so ids and slugs written with them stay readable.
 *
 * @module services/connectors/execution/connected-app-secrets
 */
import { isSecretInputKey } from '@dorkos/shared/capabilities';
import { REDACTED_SUMMARY_VALUE, redactSecretsInText } from '../../core/approvals/index.js';

/** A header written out: `Authorization: Bearer …`. The value goes whatever it looks like. */
const AUTHORIZATION_HEADER = /(Authorization:\s*)(Bearer|Basic)\s+\S+/gu;

/** `Bearer …` or `Basic …` followed by something at least credential-length. */
const CREDENTIAL_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]{16,}={0,2})/gu;

/**
 * Credentials with a shape of their own: a JSON Web Token, the prefixed keys
 * the big services issue (OpenAI, Anthropic, GitHub, GitLab, Stripe, Google,
 * npm, Slack), and an AWS access key id. Each is refused a letter or
 * digit right before it, so it has to start a token of its own.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/gu,
  /(?<![A-Za-z0-9])(?:sk-ant-|sk-|gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/gu,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/gu,
  /(?<![A-Za-z0-9])(?:xox[abpr]|xapp)-[A-Za-z0-9-]{10,}/gu,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/gu,
];

/**
 * A run of 40 or more base64 characters, swept only when it mixes upper case,
 * lower case and digits — the shape of a random key. `/`, `_` and `-` are left
 * out, so paths, slugs and ids written with them stay readable.
 *
 * It is the one rule that can also match a real id: about one Google Docs,
 * Sheets or Slides file id in four is 44 such characters. So it is skipped for
 * an argument whose name says it is an id (`file_id`, `spreadsheetId`,
 * `fileIds`), and for a run that is a whole segment of a URL path
 * (`/d/<id>/edit`). A key in a query string (`?key=…`) is still hidden.
 */
const LONG_RUN = /[A-Za-z0-9+]{40,}={0,2}/gu;

/** Whether the run at `offset` fills a whole URL path segment. */
function isPathSegment(text: string, offset: number, length: number): boolean {
  const after = text[offset + length];
  return text[offset - 1] === '/' && (after === undefined || '/?#'.includes(after));
}

/** Whether a string has upper case, lower case and a digit. */
function mixed(value: string): boolean {
  return /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /\d/u.test(value);
}

/**
 * Hide anything credential-shaped in one connected-app argument value.
 *
 * Runs the sweep every approval card gets first, then the stricter shapes.
 *
 * @param text - One argument value, or part of one.
 * @param idField - Whether the argument's name says it holds an id (see
 *   {@link isIdArgumentName}), which turns off the long-run rule only.
 * @returns The same text with credential-shaped runs replaced by `(hidden)`.
 */
export function redactConnectedAppArgument(text: string, idField = false): string {
  let swept = redactSecretsInText(text).replace(
    AUTHORIZATION_HEADER,
    `$1$2 ${REDACTED_SUMMARY_VALUE}`
  );
  swept = swept.replace(CREDENTIAL_SCHEME, (whole, scheme: string, value: string) =>
    value.includes('=') || (/\d/u.test(value) && /[A-Z]/u.test(value))
      ? `${scheme} ${REDACTED_SUMMARY_VALUE}`
      : whole
  );
  for (const shape of TOKEN_SHAPES) swept = swept.replace(shape, REDACTED_SUMMARY_VALUE);
  if (idField) return swept;
  return swept.replace(LONG_RUN, (run: string, offset: number, whole: string) =>
    mixed(run) && !isPathSegment(whole, offset, run.length) ? REDACTED_SUMMARY_VALUE : run
  );
}

/**
 * Whether an argument's name says it holds an id: its last word is `id` or
 * `ids` (`file_id`, `spreadsheetId`, `fileIds`).
 *
 * @param key - The argument's name.
 */
export function isIdArgumentName(key: string): boolean {
  const last = argumentNameWords(key).at(-1);
  return last === 'id' || last === 'ids';
}

/** Words that mark a name as a secret wherever they appear in it. */
const SECRET_WORDS = new Set(['auth', 'pwd', 'passwd']);

/** The words that make a following `key` a credential: `api_key`, `signingKey`. */
const KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'access', 'signing', 'client']);

/** An argument name split into lower-case words: `accessToken` → access, token. */
export function argumentNameWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Whether an argument's name says its value is a secret.
 *
 * The capability-wide names (`token`, `password`, `cookie`…) plus the ones a
 * service's own fields use (`auth`, `pwd`, `passwd`), and `key` only as a
 * credential compound (`api_key`, `private_key`, `signingKey`) — an
 * `idempotency_key`, a `primary_key` or an `issue_id_or_key` stays readable.
 *
 * @param key - The argument's name.
 */
export function isSecretArgumentName(key: string): boolean {
  if (isSecretInputKey(key)) return true;
  const words = argumentNameWords(key);
  return words.some(
    (word, i) =>
      SECRET_WORDS.has(word) || (word === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1]!))
  );
}
