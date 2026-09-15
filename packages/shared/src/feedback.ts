/**
 * Pure builder for the "Report an issue" GitHub link.
 *
 * GitHub is the canonical bug tracker for DorkOS. Two surfaces share ONE
 * gatherer here, {@link gatherFeedbackReport}: the `dorkos feedback` CLI command
 * and the `feedback_draft` operator capability, which is what lets an agent hand
 * somebody the link the CLI would have printed. The web app also produces a
 * prefilled `issues/new` URL through {@link buildIssueUrl}, but it builds its
 * report itself (`apps/client/.../build-issue-report.ts`) from the curated
 * ServerConfig DTO rather than from a config store, and reads a SUBSET of the
 * flags — so "the same URL builder" is true of all three and "the same details"
 * is true only of the two named above. Every surface produces a link the user
 * reviews and edits before submitting; nothing is sent anywhere, and this module
 * only assembles a URL string.
 *
 * Security note, and it has two halves that are NOT equally strong.
 *
 * The **environment** half is a guarantee: {@link sanitizeFlags} is a positive
 * allowlist, no secret, token, path or home directory is ever named in it, and
 * {@link redactSecrets} runs over the rendered block as a second pass. Nothing
 * a caller does can put a config value into the URL that the allowlist does not
 * admit.
 *
 * The **written** half is a defence, not a guarantee. `FeedbackReport.title`
 * and `FeedbackReport.body` are free-form prose an agent or a person wrote, and
 * the machine checks standing between them and the URL are {@link redactSecrets}
 * and {@link defuseSystemTags}, neither of which claims completeness.
 * What makes that acceptable here is the surface itself: the URL is handed to a
 * person, opened in GitHub's editor, and submitted by that person after reading
 * it. Never treat this module as a sanitizer for text going anywhere a person
 * does not read first.
 *
 * What is NOT left to a filter is the SHAPE of the document. Everything DorkOS
 * vouches for renders above the written prose, so nothing written can forge a
 * line above itself. See {@link renderBody}.
 *
 * @module shared/feedback
 */
import { defuseSystemTags } from './untrusted-text.js';

/** The DorkOS repository on GitHub, in `owner/name` form. */
export const FEEDBACK_REPO = 'dork-labs/dorkos';

/** Base URL for opening a new prefilled GitHub issue. */
export const FEEDBACK_ISSUES_NEW_URL = `https://github.com/${FEEDBACK_REPO}/issues/new`;

/** The kind of feedback a report carries. */
export type FeedbackKind = 'bug' | 'feature' | 'runtime';

/**
 * A single config flag's accepted value type. The sanitizer keeps a flag only
 * when its actual value matches the type named here; anything else is dropped.
 */
type FlagType = 'boolean' | 'number' | 'enum';

/**
 * The allowlist of config flags that may appear in a report, keyed by dotted
 * config path.
 *
 * This is a positive allowlist by design. Only booleans, bounded numbers, and
 * short enums are named here. Secrets (tokens, credentials), paths, hostnames,
 * timezones, and any other host-identifying string are deliberately absent, so
 * they can never be reported. Both the client and the CLI feed values keyed by
 * these exact paths; each surface reports only the flags it can see.
 */
export const FEEDBACK_FLAG_ALLOWLIST: Readonly<Record<string, FlagType>> = {
  'tunnel.enabled': 'boolean',
  'tasks.enabled': 'boolean',
  'relay.enabled': 'boolean',
  'scheduler.enabled': 'boolean',
  'mesh.enabled': 'boolean',
  'mcp.enabled': 'boolean',
  'telemetry.install': 'boolean',
  'telemetry.heartbeat': 'boolean',
  'telemetry.errorReporting': 'boolean',
  'auth.enabled': 'boolean',
  'workspace.enabled': 'boolean',
  'harness.autoSync': 'boolean',
  'harness.autoAdopt': 'boolean',
  'runtimes.codex.enabled': 'boolean',
  'runtimes.opencode.enabled': 'boolean',
  'runtimes.default': 'enum',
  'logging.level': 'enum',
  'ui.theme': 'enum',
};

/**
 * Known finite value sets for allowlisted enum flags. An enum value is reported
 * only when it appears here, so a user-customized value (e.g. a renamed theme)
 * is dropped rather than echoed. Keep these in sync with the config schema.
 */
const FEEDBACK_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  'runtimes.default': ['claude-code', 'codex', 'opencode'],
  'logging.level': ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
  'ui.theme': ['light', 'dark', 'system'],
};

/**
 * Fallback pattern for an allowlisted enum with no known value set: short,
 * lowercase, and free of slashes or whitespace. Every enum in
 * {@link FEEDBACK_FLAG_ALLOWLIST} currently has a value set in
 * {@link FEEDBACK_ENUM_VALUES}, so this only guards a future enum whose values
 * are not cleanly enumerable.
 */
const SAFE_ENUM = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** GitHub labels applied per feedback kind. All exist as repository defaults. */
const LABELS_BY_KIND: Readonly<Record<FeedbackKind, readonly string[]>> = {
  bug: ['bug'],
  feature: ['enhancement'],
  runtime: ['bug'],
};

/** A report's title placeholder, nudging the user to write a real summary. */
const TITLE_BY_KIND: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Bug: (describe what went wrong)',
  feature: 'Feature: (describe what you want)',
  runtime: 'Runtime issue: (describe what went wrong)',
};

/**
 * A feedback report, already reduced to safe values, ready to become a URL.
 */
export interface FeedbackReport {
  /** Which template the report maps to. */
  kind: FeedbackKind;
  /** DorkOS version, e.g. `0.45.1`. */
  version: string;
  /** Host platform and architecture, e.g. `darwin-arm64`. */
  platform: string;
  /** Runtimes configured on the host, e.g. `['claude-code', 'codex']`. */
  runtimes: string[];
  /** Where the report came from, e.g. `web /team`, `cli` or `agent`. */
  surface: string;
  /** Sanitized config flags. Pass the output of {@link sanitizeFlags}. */
  flags: Record<string, string | number | boolean>;
  /**
   * A written issue title, replacing the per-kind placeholder. Free-form prose:
   * it is defended by {@link redactSecrets} and by the person who reads the URL
   * before submitting, never by the allowlist. See the module docblock.
   */
  title?: string;
  /**
   * Written prose describing the issue, replacing the blank question headings.
   * Free-form, with the same defence and the same limits as {@link title}. The
   * environment block is appended below it either way.
   */
  body?: string;
}

/**
 * Everything a surface knows about itself, before the report is reduced to safe
 * values.
 *
 * Exists so the CLI and the server-side `feedback_draft` capability gather one
 * report the same way rather than two that agree by coincidence. Both the host
 * facts (`version`, `platform`) and the config reader are passed in, because
 * this module is imported by the browser client too and may touch neither
 * `node:os` nor a config store of its own.
 */
export interface FeedbackReportInput {
  /** Which template the report maps to. */
  kind: FeedbackKind;
  /** DorkOS version, e.g. `0.45.1`. */
  version: string;
  /** Host platform and architecture, e.g. `darwin-arm64`. */
  platform: string;
  /** Where the report came from, e.g. `cli` or `agent`. */
  surface: string;
  /**
   * Read one dotted config path, e.g. `runtimes.codex.enabled`. Return
   * `undefined` for anything unset or unreadable; the report degrades rather
   * than failing.
   */
  readConfigValue: (key: string) => unknown;
  /** Optional written title. See {@link FeedbackReport.title}. */
  title?: string;
  /** Optional written body. See {@link FeedbackReport.body}. */
  body?: string;
}

/**
 * The runtimes configured on this host, read through one dotted-path reader.
 *
 * claude-code is always available; codex and opencode are included unless they
 * are explicitly turned off, since both default to enabled.
 */
function configuredRuntimes(read: (key: string) => unknown): string[] {
  const runtimes = ['claude-code'];
  if (read('runtimes.codex.enabled') !== false) runtimes.push('codex');
  if (read('runtimes.opencode.enabled') !== false) runtimes.push('opencode');
  return runtimes;
}

/**
 * Gather a sanitized feedback report from a host's own view of itself.
 *
 * The one gatherer behind `dorkos feedback` and the `feedback_draft` operator
 * capability, so the link an agent hands a person is the link the CLI would
 * have printed, down to the byte, apart from the surface it names. Only the
 * paths in {@link FEEDBACK_FLAG_ALLOWLIST} are ever read.
 *
 * @param input - What this surface knows about itself and how to read config
 * @returns A report ready for {@link buildIssueUrl}
 */
export function gatherFeedbackReport(input: FeedbackReportInput): FeedbackReport {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(FEEDBACK_FLAG_ALLOWLIST)) {
    raw[key] = input.readConfigValue(key);
  }

  return {
    kind: input.kind,
    version: input.version,
    platform: input.platform,
    runtimes: configuredRuntimes(input.readConfigValue),
    surface: input.surface,
    flags: sanitizeFlags(raw),
    ...(input.title !== undefined && { title: input.title }),
    ...(input.body !== undefined && { body: input.body }),
  };
}

/**
 * Best-effort scrub of common secret, token, path, and identity shapes from a
 * string.
 *
 * This is a defensive net, NOT a guarantee. It catches common shapes (emails,
 * prefixed and high-entropy tokens, Unix/Windows/UNC paths, IP addresses), but
 * it cannot catch everything: an unprefixed key id below the entropy threshold,
 * an internal hostname, or a novel token format can survive it untouched.
 *
 * The real guarantee is the positive allowlist ({@link FEEDBACK_FLAG_ALLOWLIST}
 * plus {@link FEEDBACK_ENUM_VALUES}): a report only ever carries booleans,
 * bounded numbers, and enum values from known finite sets, none of which can be
 * a secret. Never route free-form text or user-identifying strings through this
 * function and trust it to sanitize them; add such fields to the allowlist model
 * instead, or do not report them at all.
 *
 * @param value - The raw string to clean
 * @returns The string with recognized sensitive substrings replaced
 */
export function redactSecrets(value: string): string {
  return (
    value
      // Emails.
      .replace(/[^\s/@]+@[^\s/@]+\.[^\s/@]+/g, '[email]')
      // Common credential prefixes and shapes.
      .replace(
        /\b(?:sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|npm_|xox[baprsc]-)[A-Za-z0-9._-]+/g,
        '[redacted]'
      )
      // AWS-style access key ids (AKIA/ASIA + 16 uppercase alnum).
      .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, '[redacted]')
      // IPv4 and IPv6 (and MAC-shaped) addresses.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
      .replace(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g, '[ip]')
      // Compressed IPv6 (`fe80::1`, `::1`, `2001:db8::8a2e:370:7334`). The rule
      // above needs three uncompressed groups and matches none of them, which
      // left the shortest and most common form of a link-local address in the
      // clear. Anchored on a literal `::` and on non-word boundaries, so a C++
      // scope like `foo::bar` (not hex) is untouched.
      .replace(/(?<![\w:.])(?:[A-Fa-f0-9]{1,4})?(?::[A-Fa-f0-9]{0,4}){2,}(?![\w:.])/g, '[ip]')
      // UNC network paths (\\host\share\...).
      .replace(/\\\\[^\s\\]+(?:\\[^\s\\]+)+/g, '[path]')
      // The same thing with forward slashes (`//fileserver/private/clients`),
      // which is how URLs and a lot of tooling spell it. Anchored so that the
      // `//` follows a word boundary and NOT a scheme colon, which is the one
      // distinction that matters here: `//host/share` names somebody's network,
      // `https://dorkos.ai/docs/...` names a public page and stays readable.
      .replace(/(^|[\s"'`(<[{])\/\/[^\s"'`)>\]}/]+\/[^\s"'`)>\]}]+/g, '$1[path]')
      // Windows drive paths (C:\...), greedy to end of line to catch spaces.
      .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[path]')
      // Unix home directories, then any remaining ABSOLUTE path.
      //
      // Both are anchored to a real path START — line start, whitespace, or one
      // of the characters prose wraps a path in — rather than matching any run
      // of `/segment`. Unanchored, the second rule reached inside ordinary words
      // and turned `apps/server/src/index.ts` into `apps[path]` and a URL path
      // into nonsense, which is a false positive that costs a bug report its
      // most useful line (DOR-2056 review). An absolute path is the one this
      // module has to catch, because that is what names somebody's home
      // directory; a repo-relative path names nothing about the machine.
      // The home rule's anchor also admits `/` and `:`, which the general rule
      // below must not. A home directory reached through a URL or a drive
      // (`file:///Users/dorian/...`, `file:///C:/Users/dorian/...`) is preceded
      // by one of those and leaked the account name in the clear until this was
      // measured (DOR-2056 delta review). Widening is safe HERE and only here
      // because this rule matches three literal heads and nothing else, so
      // `apps/server/src/index.ts` still has no head to match.
      .replace(/(^|[\s"'`(<[{/:])(~|\/(?:Users|home))\/[^\s"'`)>\]}]+/g, '$1[home]')
      .replace(/(^|[\s"'`(<[{])\/[\w.-]+(?:\/[\w.-]*)+/g, '$1[path]')
      // Long high-entropy tokens, with a DIGIT required somewhere in the run.
      //
      // The digit is what tells a secret from an identifier. Without it this
      // rule ate `createSidebarRemoveFromGroupHandler` and every other long
      // camelCase name a bug report might legitimately quote (DOR-2056 review).
      // Real credentials carry digits: ngrok authtokens, JWT segments, and every
      // base64 blob long enough to reach 24 characters in practice.
      //
      // KNOWN GAP, and it is the reason this is a defence and not a guarantee: a
      // 24-character all-alphabetic secret survives this rule untouched. The
      // prefixed shapes above are what actually carry the weight; this is the
      // net under them, and it is now a slightly looser net in exchange for not
      // shredding the prose it runs over.
      .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
  );
}

/** Decide whether an allowlisted enum value is safe to report. */
function isSafeEnum(key: string, value: string): boolean {
  const known = FEEDBACK_ENUM_VALUES[key];
  // Prefer the known finite set: only exact members pass, so a user-customized
  // value is dropped rather than echoed.
  if (known) return known.includes(value);
  // No enumerable set: fall back to the shape check plus a redaction check that
  // rejects anything the defensive pass would scrub (a stray token or path).
  return SAFE_ENUM.test(value) && redactSecrets(value) === value;
}

/**
 * Reduce a raw record of config values to the allowlisted, safe subset.
 *
 * Only keys named in {@link FEEDBACK_FLAG_ALLOWLIST} survive, and only when the
 * value matches the expected type. Enum values must belong to their known set in
 * {@link FEEDBACK_ENUM_VALUES} (or, lacking one, pass the {@link SAFE_ENUM}
 * shape). Everything else is dropped, so unknown or sensitive keys can never be
 * reported.
 *
 * @param raw - Config values keyed by dotted path (missing keys are fine)
 * @returns A record containing only safe, reportable flags
 */
export function sanitizeFlags(
  raw: Record<string, unknown>
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};

  for (const [key, type] of Object.entries(FEEDBACK_FLAG_ALLOWLIST)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;

    if (type === 'boolean' && typeof value === 'boolean') {
      safe[key] = value;
    } else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
    } else if (type === 'enum' && typeof value === 'string' && isSafeEnum(key, value)) {
      safe[key] = value;
    }
  }

  return safe;
}

/**
 * The markup this module uses to structure the issue body.
 *
 * Defused in written prose so a body cannot spell the tags that hold the
 * document together. After the reorder in {@link renderBody} this is no longer
 * load-bearing on its own — the written half renders last, so a forged
 * `</details>` closes nothing that is still open — which is exactly why it is
 * worth keeping: it costs a regex over two words, and it is the half that keeps
 * holding if somebody ever moves the blocks back.
 */
const FEEDBACK_STRUCTURAL_TAGS: readonly string[] = ['details', 'summary'];

/**
 * Clean one piece of free-form prose on its way into the issue.
 *
 * Two passes, in this order and for different reasons. {@link redactSecrets}
 * runs FIRST, over the text exactly as it was written, because every shape it
 * hunts for is defined on the original characters and escaping an angle bracket
 * ahead of it would only give it a different string to miss. Then
 * {@link defuseSystemTags} escapes the structural markup.
 *
 * Neither is a guarantee over prose. Read the module docblock for what is.
 *
 * @param text - Prose a model or a person wrote.
 * @returns The text with recognized secrets replaced and structural tags defused.
 */
function sanitizeWritten(text: string): string {
  return defuseSystemTags(redactSecrets(text), FEEDBACK_STRUCTURAL_TAGS);
}

/** Render the environment block that DorkOS fills in for the user. */
function renderEnvironment(report: FeedbackReport): string {
  const runtimes = report.runtimes.length > 0 ? report.runtimes.join(', ') : 'none configured';
  const flagLines = Object.entries(report.flags)
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join('\n');

  const lines = [
    `- DorkOS version: ${report.version}`,
    `- OS / arch: ${report.platform}`,
    `- Runtimes configured: ${runtimes}`,
    `- Reported from: ${report.surface}`,
    '',
    'Settings (on/off values only, no secrets or file paths):',
    flagLines.length > 0 ? flagLines : '- (none available)',
  ];

  return redactSecrets(lines.join('\n'));
}

/**
 * Render the top of the issue body: the written prose when there is any, and
 * otherwise the blank question headings for the user to fill in.
 *
 * Written prose REPLACES the headings rather than sitting above them, because a
 * report that already says what happened and then asks "What happened?" reads as
 * a form nobody filled in. The person can still edit either in GitHub.
 */
function renderWritten(report: FeedbackReport): string[] {
  const written = report.body?.trim();
  if (written) return [sanitizeWritten(written)];

  return report.kind === 'feature'
    ? ['## What do you want DorkOS to do?', '', '', '## Why would it help?', '', '']
    : [
        '## What happened?',
        '',
        '',
        '## What did you expect?',
        '',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '2. ',
        '3. ',
      ];
}

/**
 * Render the full issue body: what DorkOS filled in, then what was written.
 *
 * **The order is the security boundary, and it used to be the other way round.**
 * Everything DorkOS vouches for goes FIRST; the free-form prose goes LAST, where
 * nothing it contains can forge anything above it. With the written half on top,
 * a body carrying its own copy of "DorkOS filled in the details below" plus a
 * `<details><summary>Environment</summary>` block rendered as machine output
 * with a person's own words nowhere in sight, and a bare `<!--` anywhere in it
 * commented out the real block that followed (DOR-2056 review).
 *
 * Reversed, both attacks are structurally dead rather than filtered: a forged
 * block can only appear below the real one, and an unclosed comment can only
 * swallow what the writer wrote after it. {@link sanitizeWritten} is defence in
 * depth on top of that, not the thing holding the boundary.
 *
 * The cost is that a maintainer opens the issue on a collapsed Environment
 * summary rather than on the report. One line, collapsed by default, above the
 * sentence that explains it.
 */
function renderBody(report: FeedbackReport): string {
  return [
    '<details><summary>Environment</summary>',
    '',
    renderEnvironment(report),
    '',
    '</details>',
    '',
    'DorkOS filled in the details above. Please check them and remove anything you do not want to share.',
    '',
    '---',
    '',
    ...renderWritten(report),
  ].join('\n');
}

/** Assemble the URL for one report, with no size check. */
function renderUrl(report: FeedbackReport): string {
  const written = report.title?.trim();
  const params = new URLSearchParams({
    title: sanitizeWritten(written || TITLE_BY_KIND[report.kind]),
    body: renderBody(report),
    labels: LABELS_BY_KIND[report.kind].join(','),
  });
  return `${FEEDBACK_ISSUES_NEW_URL}?${params.toString()}`;
}

/**
 * The biggest URL this module will hand out, in BYTES of the encoded address.
 *
 * Bytes, not characters, because that is what the far end counts and the two
 * are not close. Measured against github.com on 2026-09-15: a 4,000-character
 * ASCII body is served fine, while 1,500 Cyrillic characters, 800 CJK
 * characters and 4,000 CJK characters all come back HTTP 414. Every non-ASCII
 * character costs three to nine bytes once percent-encoded, and a newline costs
 * three, so a character budget is not a budget at all.
 *
 * 6 KB against a real limit somewhere past 8 KB, so the margin absorbs both the
 * environment block growing and whatever the far end counts that we do not.
 */
export const FEEDBACK_URL_MAX_BYTES = 6000;

/** What a shortened body ends with, so the person can see something is missing. */
const TRUNCATION_MARKER = '\n\n… (shortened to fit the link; paste the rest yourself)';

/** Byte length of a string once it is on the wire. */
function byteLength(value: string): number {
  // `TextEncoder`, not `Buffer.byteLength`: this module is imported by the
  // browser client, where `Buffer` does not exist.
  return new TextEncoder().encode(value).length;
}

/** A prefix of `text` by CODE POINT, so a cut never splits a surrogate pair. */
function codePointPrefix(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('');
}

/** A prefilled issue link, and whether the body had to be shortened to fit. */
export interface FeedbackDraft {
  /** The `github.com/.../issues/new?...` address. */
  url: string;
  /** Whether {@link FEEDBACK_URL_MAX_BYTES} forced the written body shorter. */
  truncated: boolean;
  /**
   * The sanitized body in full, present only when `truncated` is true, so a
   * caller can hand the person the part the link could not carry.
   */
  fullBody?: string;
}

/**
 * Build a prefilled GitHub "new issue" link, shortened if it would not fit.
 *
 * Only the WRITTEN body is ever shortened. The environment block is left whole:
 * it is the part DorkOS vouches for, it is bounded by the flag allowlist, and
 * dropping half of it would produce a report that reads complete and is not. So
 * a report with no body is returned as built with `truncated: false`, whatever
 * its size: the flag means "your body was cut", and there was no body to cut.
 *
 * The search is over CODE POINTS rather than bytes, so a cut lands between
 * characters and never inside an emoji or a surrogate pair.
 *
 * @param report - The sanitized report (build `flags` with {@link sanitizeFlags})
 * @param maxBytes - Ceiling for the encoded URL; defaults to
 *   {@link FEEDBACK_URL_MAX_BYTES}.
 * @returns The link, plus whether the body was shortened and what it said in full.
 */
export function buildIssueDraft(
  report: FeedbackReport,
  maxBytes: number = FEEDBACK_URL_MAX_BYTES
): FeedbackDraft {
  const url = renderUrl(report);
  if (byteLength(url) <= maxBytes) return { url, truncated: false };

  const written = report.body?.trim() ?? '';
  // Nothing written means nothing to shorten. The environment block is never
  // truncated, so the only honest answer here is the address as built and
  // `truncated: false`: the flag says "your body was cut", and claiming it over
  // a report that has no body would send an agent hunting for a `fullBody` that
  // says nothing (DOR-2056 delta review). Reachable only if the environment
  // block alone outgrew the budget, which the flag allowlist bounds.
  if (!written) return { url, truncated: false };

  const points = Array.from(written).length;

  // Largest prefix that still fits, found by bisection: the relationship between
  // characters kept and bytes produced is monotonic but wildly non-linear across
  // scripts, so stepping by a fixed fraction either overshoots on CJK or takes
  // hundreds of renders on ASCII.
  let low = 0;
  let high = points;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = { ...report, body: codePointPrefix(written, mid) + TRUNCATION_MARKER };
    if (byteLength(renderUrl(candidate)) <= maxBytes) low = mid;
    else high = mid - 1;
  }

  const shortened = { ...report, body: codePointPrefix(written, low) + TRUNCATION_MARKER };
  return {
    url: renderUrl(shortened),
    truncated: true,
    fullBody: sanitizeWritten(written),
  };
}

/**
 * Build a prefilled GitHub "new issue" URL from a feedback report.
 *
 * The returned URL opens the GitHub issue editor with a title, body, and labels
 * already filled in. Every value passes through {@link redactSecrets}, including
 * a written `title` or `body`; read the module docblock for how far that reaches
 * on free-form prose and what actually backstops it.
 *
 * Shortens an over-long body exactly as {@link buildIssueDraft} does — reach for
 * that one when you need to tell the person something was left out.
 *
 * @param report - The sanitized report (build `flags` with {@link sanitizeFlags})
 * @returns A `github.com/.../issues/new?...` URL as a string
 */
export function buildIssueUrl(report: FeedbackReport): string {
  return buildIssueDraft(report).url;
}
