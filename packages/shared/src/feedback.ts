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
 * Pattern an enum value must match to be reported: short, lowercase, and free of
 * slashes or whitespace. This blocks a filesystem path or a token from ever
 * passing through an allowlisted enum key.
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
 * Redact anything that looks like a secret, token, path, home directory, or
 * email from a string.
 *
 * This is a defensive second pass. Reported values are already allowlisted, but
 * redaction guarantees that even a mistaken or malicious value cannot leak the
 * user's identity or credentials into the URL.
 *
 * @param value - The raw string to clean
 * @returns The string with sensitive substrings replaced by a placeholder
 */
export function redactSecrets(value: string): string {
  return (
    value
      // Emails.
      .replace(/[^\s/@]+@[^\s/@]+\.[^\s/@]+/g, '[email]')
      // Common credential prefixes followed by their token body.
      .replace(/\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, '[redacted]')
      // Windows paths (C:\Users\name\...).
      .replace(/\b[A-Za-z]:\\[^\s]+/g, '[path]')
      // Unix home directories, then any remaining absolute path.
      .replace(/\/(?:Users|home)\/[^\s/]+/g, '[home]')
      .replace(/(?:\/[\w.-]+){2,}\/?/g, '[path]')
      // Long high-entropy tokens (>= 24 chars of base64-ish text).
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
  );
}

/**
 * Reduce a raw record of config values to the allowlisted, safe subset.
 *
 * Only keys named in {@link FEEDBACK_FLAG_ALLOWLIST} survive, and only when the
 * value matches the expected type. Enums must also pass the {@link SAFE_ENUM}
 * shape. Everything else is dropped, so unknown or sensitive keys can never be
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
    } else if (
      type === 'enum' &&
      typeof value === 'string' &&
      SAFE_ENUM.test(value) &&
      redactSecrets(value) === value
    ) {
      // The shape check bounds the value; the redaction check rejects anything
      // the defensive pass would scrub (a stray token, path, or email).
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
