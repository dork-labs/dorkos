/**
 * Pure builder for the "Report an issue" GitHub link.
 *
 * GitHub is the canonical bug tracker for DorkOS. Both the web cockpit and the
 * `dorkos feedback` CLI command gather the same environment details, run them
 * through the sanitizer here, and open a prefilled `issues/new` URL so the user
 * can review and edit everything before submitting. Nothing is sent anywhere;
 * this module only assembles a URL string.
 *
 * Security note: {@link sanitizeFlags} is a positive allowlist and
 * {@link redactSecrets} is a defensive second pass. No secret, token, path, or
 * home directory is ever named in the allowlist, so none can reach the URL.
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
  'telemetry.enabled': 'boolean',
  'auth.enabled': 'boolean',
  'workspace.enabled': 'boolean',
  'harness.autoSync': 'boolean',
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
  /** Where the report came from, e.g. `web /agents` or `cli`. */
  surface: string;
  /** Sanitized config flags. Pass the output of {@link sanitizeFlags}. */
  flags: Record<string, string | number | boolean>;
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

/** Render the full issue body: a prompt for the user, then the environment. */
function renderBody(report: FeedbackReport): string {
  const prompt =
    report.kind === 'feature'
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
 * already filled in. Every value passes through {@link redactSecrets} so the
 * URL can never carry a secret, token, path, or email.
 *
 * @param report - The sanitized report (build `flags` with {@link sanitizeFlags})
 * @returns A `github.com/.../issues/new?...` URL as a string
 */
export function buildIssueUrl(report: FeedbackReport): string {
  const params = new URLSearchParams({
    title: redactSecrets(TITLE_BY_KIND[report.kind]),
    body: renderBody(report),
    labels: LABELS_BY_KIND[report.kind].join(','),
  });
  return `${FEEDBACK_ISSUES_NEW_URL}?${params.toString()}`;
}
