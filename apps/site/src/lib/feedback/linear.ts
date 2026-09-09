/**
 * Minimal, write-capable Linear client for the feedback intake pipeline
 * (feedback-pipeline, decision 260803-205035).
 *
 * Raw GraphQL over `fetch` — no `@linear/sdk`. This matches the style of the
 * only existing Linear client in the repo, the read-only, user-supplied-key
 * extension at `apps/server/src/core-extensions/linear-issues/server.ts`:
 * same `gql()` helper shape, same `Authorization: <apiKey>` header (the raw
 * key, NOT `Bearer <key>` — Linear's personal/app API keys go in the header
 * unprefixed). This repo has never taken the `@linear/sdk` dependency and one
 * small mutation doesn't justify starting.
 *
 * Unlike that extension (a user-supplied key read from per-install secret
 * storage), this client is authenticated with a **server-only key from site
 * env** (`LINEAR_API_KEY`), because feedback intake runs unattended on every
 * submission, not on a per-user configured integration.
 *
 * **Error posture**: {@link createFeedbackIssue} throws on a real Linear API
 * error (network failure, non-2xx, a GraphQL `errors[]`, or an unsuccessful
 * mutation) — it does NOT swallow failures itself. The caller
 * (`POST /api/feedback`) decides how to degrade: Linear is best-effort on top
 * of the durable Neon insert, so the route catches this and leaves the row
 * `status: 'received'` rather than letting a Linear hiccup fail the request.
 * The one exception is a genuinely unconfigured deployment: with
 * `LINEAR_API_KEY` (or `LINEAR_TEAM_ID`) unset, this resolves `null` instead
 * of throwing — the same "accept, don't error" posture as every other
 * optional integration in this pipeline.
 *
 * @module lib/feedback/linear
 */
import { env } from '@/env';

const LINEAR_API = 'https://api.linear.app/graphql';

/** Submission kind, mirrors `FeedbackKind` in `db/feedback-schema.ts`. */
export type FeedbackIssueKind = 'feedback' | 'bug' | 'idea';

/** Input to {@link createFeedbackIssue}. */
export interface CreateFeedbackIssueInput {
  /** Drives the label mapping (see {@link labelIdsForKind}). */
  kind: FeedbackIssueKind;
  /** The full report body. Title is derived from this (truncated first line). */
  message: string;
  /** Resolved server-side account email, if any. */
  reporterEmail?: string;
  /** Resolved server-side account display name, if any. */
  reporterName?: string;
  /** Free-text contact the reporter typed themselves. */
  contact?: string;
  /** The app route the reporter was on, if resolvable. */
  route?: string;
  /** Which product surface the submission came from. */
  surface?: 'cockpit' | 'site';
  /**
   * Public status-page URL for the submission (`/feedback/{id}`). The page
   * itself only shows status/kind/date; the value of the line is that the URL
   * carries the Neon row id, which is what a triager or support reply needs to
   * look the row up.
   */
  submissionUrl?: string;
  /**
   * Raw diagnostics text (version/platform/runtimes/breadcrumbs) as bundled
   * upstream. This module owns rendering it safely into the description —
   * callers pass it unrendered.
   */
  diagnostics?: string;
  /** Raw transcript excerpt, rendered here the same way as `diagnostics`. */
  transcriptExcerpt?: string;
  /** Screenshot / log / transcript attachment URLs, pre-uploaded by the caller. */
  attachmentUrls?: string[];
}

/** Result of a successful issue create. */
export interface CreateFeedbackIssueResult {
  issueId: string;
  issueUrl: string;
}

const ISSUE_CREATE_MUTATION = `
  mutation FeedbackIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
      }
    }
  }
`;

interface IssueCreateResponse {
  data?: {
    issueCreate?: {
      success: boolean;
      issue?: { id: string; identifier: string; url: string };
    };
  };
  errors?: Array<{ message: string }>;
}

/** Raw GraphQL POST, mirroring the extension's `gql()` helper. Throws on any non-success outcome. */
async function gql(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<IssueCreateResponse> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    // The raw key, NOT `Bearer <key>` — Linear's API expects the API key
    // unprefixed in the Authorization header.
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status}`);
  }
  const json = (await res.json()) as IssueCreateResponse;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json;
}

/** Truncate a string to `max` chars, appending an ellipsis when cut. */
function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

const MAX_TITLE_LEN = 80;
// Defensive ceiling well under Linear's own description limit, so a
// pathological submission (e.g. thousands of backticks amplifying the fence
// padding) degrades to a deterministic truncation instead of a
// Linear-dependent API error.
const MAX_DESCRIPTION_LEN = 60_000;
const TRUNCATION_MARKER = '\n\n… (truncated)';

/** Title = truncated first line of the message. */
function buildTitle(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? message;
  return truncate(firstLine, MAX_TITLE_LEN) || 'Feedback submission';
}

/**
 * Collapse a caller-supplied value to a single line. The `**Submitted by**`
 * block is a `Key: value` parsing contract, and `contact`/`route`/
 * `reporterName` arrive from an unauthenticated endpoint with only a length
 * cap — an embedded newline would let a submitter forge extra `Key:` lines
 * (a fake `Submission:` link, a second `Kind:`). One line in, one line out.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * One `Reporter:` line. The upstream resolver may only know the account email,
 * in which case it sends it as the name too — collapse that to the email alone
 * rather than printing the address twice. The email rides in parentheses, not
 * `<angle brackets>`: Linear's markdown turns `<email>` into an autolink,
 * which mangled the line when name and email were both addresses.
 */
function buildReporterLine(input: CreateFeedbackIssueInput): string | undefined {
  const name = input.reporterName ? oneLine(input.reporterName) : undefined;
  const email = input.reporterEmail ? oneLine(input.reporterEmail) : undefined;
  if (email) {
    const distinctName = name && name.toLowerCase() !== email.toLowerCase() ? name : undefined;
    return `Reporter: ${distinctName ? `${distinctName} (${email})` : email}`;
  }
  if (name) return `Reporter: ${name}`;
  return undefined;
}

/**
 * Wrap free text in a markdown code fence long enough that no backtick run
 * inside the text can close it early. Diagnostics and transcripts are
 * user/session content — fencing keeps Linear from rendering their markdown
 * (a chat excerpt full of `**` or links would garble), keeps line breaks and
 * monospace alignment, and gives a parsing agent unambiguous delimiters.
 * Line endings are normalized to `\n`; leading blank lines and trailing
 * whitespace are stripped without touching the first line's indentation.
 */
function fenceBlock(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
  const longestBacktickRun = normalized
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, (longestBacktickRun ?? 0) + 1));
  return `${fence}text\n${normalized}\n${fence}`;
}

/**
 * Description = full message + a rendered identity block + diagnostics +
 * attachments. The message is reporter prose and renders unescaped, so a
 * submitter can imitate the blocks below it — when parsing, the LAST
 * occurrence of a `Key:` line is the authoritative one, since the genuine
 * block is appended after the message.
 */
function buildDescription(input: CreateFeedbackIssueInput): string {
  const sections = [input.message.trim()];

  const identityLines: string[] = [];
  const reporterLine = buildReporterLine(input);
  if (reporterLine) identityLines.push(reporterLine);
  if (input.contact) identityLines.push(`Contact: ${oneLine(input.contact)}`);
  // One `Key: value` line each — a triaging agent parses these without
  // guessing, and `Kind:` is the only place a plain `feedback` submission's
  // kind is visible at all (only bug/idea get labels).
  identityLines.push(`Kind: ${input.kind}`);
  if (input.surface) identityLines.push(`Surface: ${input.surface}`);
  if (input.route) identityLines.push(`Route: ${oneLine(input.route)}`);
  if (input.submissionUrl) identityLines.push(`Submission: ${input.submissionUrl}`);
  sections.push(['---', '**Submitted by**', ...identityLines].join('\n'));

  const diagnosticsParts: string[] = [];
  if (input.diagnostics?.trim()) diagnosticsParts.push(fenceBlock(input.diagnostics));
  if (input.transcriptExcerpt?.trim()) {
    diagnosticsParts.push(`Transcript excerpt:\n${fenceBlock(input.transcriptExcerpt)}`);
  }
  if (diagnosticsParts.length > 0) {
    sections.push(['---', '**Diagnostics**', ...diagnosticsParts].join('\n'));
  }

  if (input.attachmentUrls && input.attachmentUrls.length > 0) {
    sections.push(
      ['---', '**Attachments**', ...input.attachmentUrls.map((url) => `- ${url}`)].join('\n')
    );
  }

  const description = sections.join('\n\n');
  if (description.length <= MAX_DESCRIPTION_LEN) return description;
  return description.slice(0, MAX_DESCRIPTION_LEN - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Map submission kind to Linear label ids. `bug` → `LINEAR_BUG_LABEL_ID`,
 * `idea` → `LINEAR_FEATURE_LABEL_ID`, plain `feedback` → no label. Either env
 * var being unset just files the issue without that label — labels are a
 * triage nicety, never a precondition for creating the issue.
 */
function labelIdsForKind(kind: FeedbackIssueKind): string[] {
  if (kind === 'bug' && env.LINEAR_BUG_LABEL_ID) return [env.LINEAR_BUG_LABEL_ID];
  if (kind === 'idea' && env.LINEAR_FEATURE_LABEL_ID) return [env.LINEAR_FEATURE_LABEL_ID];
  return [];
}

/**
 * Create a Linear issue for a feedback submission.
 *
 * Resolves `null` (no-op) when `LINEAR_API_KEY` or `LINEAR_TEAM_ID` is unset
 * — an unconfigured deployment degrades silently, matching the rest of this
 * pipeline's optional-integration posture. Once configured, throws on any
 * real failure (network error, non-2xx, GraphQL errors, or
 * `issueCreate.success === false`) so the caller can decide how to degrade;
 * this function never swallows an error itself.
 */
export async function createFeedbackIssue(
  input: CreateFeedbackIssueInput
): Promise<CreateFeedbackIssueResult | null> {
  const apiKey = env.LINEAR_API_KEY;
  const teamId = env.LINEAR_TEAM_ID;
  if (!apiKey || !teamId) return null;

  const json = await gql(apiKey, ISSUE_CREATE_MUTATION, {
    input: {
      teamId,
      projectId: env.LINEAR_FEEDBACK_PROJECT_ID || undefined,
      title: buildTitle(input.message),
      description: buildDescription(input),
      labelIds: labelIdsForKind(input.kind),
    },
  });

  const result = json.data?.issueCreate;
  if (!result?.success || !result.issue) {
    throw new Error('Linear issueCreate did not report success');
  }

  return { issueId: result.issue.id, issueUrl: result.issue.url };
}
