/**
 * What the audit log sweeps out of a row before it is hashed (spec
 * `audit-trail` §3.3): credential shapes in free text, and the values of any
 * changed field named like a secret. Split from `audit-log.ts` so the writer
 * reads as the writer; `AuditLog.record` is the only caller of the change
 * sweep, and the runtime tool recorder also sweeps its own short target here.
 *
 * @module services/audit/audit-redaction
 */
import { redactCredentialTokens } from '@dorkos/shared/feedback';
import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import { redactSecretsInText } from '../core/approvals/approval-summary.js';

/** How long a free-text field may be, after redaction. */
const MAX_TEXT = 2_000;

/** What a redacted value is replaced with. */
const REDACTED = '[redacted]';

/** The longest stretch of a free-text field that is swept; the rest is cut. */
const MAX_SWEPT = 16_000;

/** Words that make any name a secret's name wherever they appear in it. */
const SECRET_WORD =
  /pass(?:word|wd)|pwd|secret|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|authorization/i;

/**
 * Whether a name says its value is a secret.
 *
 * Written as a few plain checks rather than one pattern with open-ended runs
 * on both sides, which backtracked quadratically: a 100,000-character name took
 * seconds and blocked the server (DOR-2738 review). Each check here is linear.
 *
 * `token` counts as the whole name or its last part (`token`, `access_token`,
 * `x-auth-token`, `accessToken`), never as a plural or a middle (`maxTokens`,
 * `tokenizer`). `auth` likewise (`auth`, `basic_auth`, `authKey`), never
 * `author`.
 *
 * @param name - A key, a setting path segment, or the name in `name=value`.
 */
function isSecretName(name: string): boolean {
  return (
    SECRET_WORD.test(name) ||
    /(?:^|[_.-])token$/i.test(name) ||
    /[a-z]Token$/.test(name) ||
    /(?:^|[_.-])auth(?:$|[_.-])/i.test(name) ||
    /^auth[A-Z]/.test(name)
  );
}

/** A command line that runs a MySQL or MariaDB client. */
const MYSQL_CLIENT = /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b/;

/** Shapes a secret takes in free text, each with what to keep around it. */
const SECRET_TEXT: readonly [RegExp, (match: string, ...groups: string[]) => string][] = [
  // `Authorization: Basic <token>`, `Bearer <token>`: first, because the
  // name-value rule below would take only the scheme word and leave the token.
  [
    /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    (_m, scheme, gap) => `${scheme}${gap}${REDACTED}`,
  ],
  // A Telegram bot token, which rides in the URL path: `/bot123456:AAE…`.
  [/\bbot(\d{5,}):[A-Za-z0-9_-]{30,}/g, () => `bot${REDACTED}`],
  // A cookie header carries a session: `Cookie: session=…; csrftoken=…`.
  [/\b((?:Set-)?Cookie:\s*)[^\n"']+/gi, (_m, head) => `${head}${REDACTED}`],
  // `curl -u user:password`, `--user user:password`: keep the user.
  [
    /(?<!\S)(-u|--user)(\s+|=)([^\s:"']+):([^\s"']+)/g,
    (_m, flag, gap, user) => `${flag}${gap}${user}:${REDACTED}`,
  ],
  // `docker login -p <password>`: `-p` is a secret only on that command.
  [
    /(\bdocker\s+login\b[^\n]*?\s)-p(\s+|=)[^\s"']+/g,
    (_m, head, gap) => `${head}-p${gap}${REDACTED}`,
  ],
  // `aws configure set aws_secret_access_key <value>`: a secret-named key
  // handed to a `set` subcommand, with its value as the next word.
  [
    /(\bset\s+)([A-Za-z0-9_.-]{1,128})(\s+)([^\s"']+)/g,
    (match, head, name, gap) => (isSecretName(name) ? `${head}${name}${gap}${REDACTED}` : match),
  ],
  // `"apiKey": "abcd1234"` — a JSON (or JSON-ish) member named like a secret.
  // The name is bounded, so each quote costs a bounded amount.
  [
    /"([^"\\\n]{1,128})"(\s*:\s*")([^"]*)"/g,
    (match, name, gap) => (isSecretName(name) ? `"${name}"${gap}${REDACTED}"` : match),
  ],
  // `password=hunter2`, `OPENAI_API_KEY=abcd`, `?access_token=…`, `token: abc`.
  // The lookbehind lets a name start only where a run of name characters
  // starts, which is what keeps this linear on one very long run. A `://` is a
  // URL scheme, not a name and its value: matching `https:` there swallowed the
  // whole URL as one value, and a secret later in it was never looked at. For
  // the same reason a value stops at `?` and `#`: `host:8080/cb?token=…` must
  // leave the query for the next match.
  [
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,128})(\s*[=:](?!\/\/)\s*["']?)([^\s"'&,;?#]+)/g,
    (match, name, gap) => (isSecretName(name) ? `${name}${gap}${REDACTED}` : match),
  ],
  // The password in a URL: `https://user:secret@host`.
  [
    /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)[^\s/@]+@/gi,
    (_m, head) => `${head}${REDACTED}@`,
  ],
  // A JWT: three base64url segments, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, () => REDACTED],
  // A command-line flag named like a secret with its value after a space:
  // `--password hunter2`, `--api-key abcd`. (`--token=abcd` is the rule above.)
  [
    /(?<![A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9_-]{0,63})(\s+)(?!-)([^\s"'&;|]+)/g,
    (match, flag, gap) =>
      isSecretName(flag.replace(/^-+/, '')) ? `${flag}${gap}${REDACTED}` : match,
  ],
  // Google, Notion, Stripe and Slack app tokens by their prefixes.
  [/\b(?:AIza|ntn_|secret_|sk_live_|sk_test_|rk_live_|xapp-)[A-Za-z0-9_-]{10,}/g, () => REDACTED],
];

/**
 * Sweep anything that looks like a password or key out of a string, and cap
 * its length. Best effort, as every pattern sweep is; the rule that makes it
 * enough is that callers never put a secret's value in an event on purpose.
 *
 * The input is cut to {@link MAX_SWEPT} before the sweep, so no caller can make
 * one record expensive, and to {@link MAX_TEXT} after it. Sweeping before the
 * final cut matters: cutting first can leave the start of a secret too short to
 * be recognised. Exported so a caller that cuts a value shorter still (a
 * runtime tool's target) can sweep it first.
 *
 * @param text - The free text to sweep.
 */
export function redactAuditText(text: string): string {
  let swept = redactSecretsInText(redactCredentialTokens(text.slice(0, MAX_SWEPT)));
  for (const [pattern, replace] of SECRET_TEXT) swept = swept.replace(pattern, replace);
  // MySQL and MariaDB take a password glued to `-p` (`mysql -pHunter2`). Only
  // on a line that runs one of them: elsewhere `-p…` is an ordinary flag.
  if (MYSQL_CLIENT.test(swept))
    swept = swept.replace(/(?<!\S)-p(?=[^\s"'])[^\s"']+/g, `-p${REDACTED}`);
  return swept.length <= MAX_TEXT ? swept : `${swept.slice(0, MAX_TEXT - 1)}…`;
}

/**
 * Redact every string inside a JSON-compatible value, and empty the value of
 * any member whose name says it is a secret (unless it is a number or a
 * yes/no, which no secret is).
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactAuditText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        // A number or a yes/no under a secret-sounding name (`passwordMinLength:
        // 8`) is a setting, not a secret, so it is kept.
        isSecretName(key) && typeof inner !== 'number' && typeof inner !== 'boolean'
          ? REDACTED
          : redactDeep(inner),
      ])
    );
  }
  return value;
}

const SENSITIVE = new Set<string>(SENSITIVE_CONFIG_KEYS);

/**
 * Whether a changed field is a secret: listed in `SENSITIVE_CONFIG_KEYS`, or
 * any segment of its path is named like one (`connectors.composio.apiKey`).
 */
function isSecretField(field: string): boolean {
  return SENSITIVE.has(field) || field.split('.').some(isSecretName);
}

/**
 * A change list with secret fields emptied and every value swept.
 *
 * @param change - The change list as the caller handed it.
 */
export function redactChange(change: AuditChange[]): AuditChange[] {
  return change.map((entry) =>
    isSecretField(entry.field)
      ? { field: entry.field, redacted: true }
      : {
          field: entry.field,
          ...('before' in entry ? { before: redactDeep(entry.before) } : {}),
          ...('after' in entry ? { after: redactDeep(entry.after) } : {}),
          ...(entry.redacted ? { redacted: true } : {}),
        }
  );
}
