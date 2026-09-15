/**
 * Pure builder for the "Report an issue" GitHub link.
 *
 * GitHub is the canonical bug tracker for DorkOS. The web app, the
 * `dorkos feedback` CLI command and the `feedback_draft` operator capability all
 * gather the same environment details, run them through the sanitizer here, and
 * produce a prefilled `issues/new` URL so the user can review and edit
 * everything before submitting. Nothing is sent anywhere; this module only
 * assembles a URL string.
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
 * the only machine check standing between them and the URL is
 * {@link redactSecrets}, whose own docblock says plainly what it cannot catch.
 * What makes that acceptable here is the surface itself: the URL is handed to a
 * person, opened in GitHub's editor, and submitted by that person after reading
 * it. Never treat this module as a sanitizer for text going anywhere a person
 * does not read first.
 *
 * @module shared/feedback
 */

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
        /\b(?:sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[baprsc]-)[A-Za-z0-9._-]+/g,
        '[redacted]'
      )
      // AWS-style access key ids (AKIA/ASIA + 16 uppercase alnum).
      .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, '[redacted]')
      // IPv4 and IPv6 (and MAC-shaped) addresses.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
      .replace(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g, '[ip]')
      // UNC network paths (\\host\share\...).
      .replace(/\\\\[^\s\\]+(?:\\[^\s\\]+)+/g, '[path]')
      // Windows drive paths (C:\...), greedy to end of line to catch spaces.
      .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[path]')
      // Unix home directories, then any remaining absolute path.
      .replace(/\/(?:Users|home)\/[^\s/]+/g, '[home]')
      .replace(/(?:\/[\w.-]+){2,}\/?/g, '[path]')
      // Long high-entropy tokens (>= 24 chars of base64-ish text).
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
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
  if (written) return [redactSecrets(written)];

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

/** Render the full issue body: a prompt for the user, then the environment. */
function renderBody(report: FeedbackReport): string {
  const prompt = renderWritten(report);

  return [
    ...prompt,
    '',
    '---',
    '',
    'DorkOS filled in the details below. Please check them and remove anything you do not want to share.',
    '',
    '<details><summary>Environment</summary>',
    '',
    renderEnvironment(report),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Build a prefilled GitHub "new issue" URL from a feedback report.
 *
 * The returned URL opens the GitHub issue editor with a title, body, and labels
 * already filled in. Every value passes through {@link redactSecrets}, including
 * a written `title` or `body`; read the module docblock for how far that reaches
 * on free-form prose and what actually backstops it.
 *
 * @param report - The sanitized report (build `flags` with {@link sanitizeFlags})
 * @returns A `github.com/.../issues/new?...` URL as a string
 */
export function buildIssueUrl(report: FeedbackReport): string {
  const written = report.title?.trim();
  const params = new URLSearchParams({
    title: redactSecrets(written || TITLE_BY_KIND[report.kind]),
    body: renderBody(report),
    labels: LABELS_BY_KIND[report.kind].join(','),
  });
  return `${FEEDBACK_ISSUES_NEW_URL}?${params.toString()}`;
}
