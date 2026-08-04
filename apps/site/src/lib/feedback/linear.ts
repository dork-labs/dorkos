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
  /**
   * Pre-rendered diagnostics block (version/platform/runtimes/log excerpt
   * summary) — rendering is the route's job (Part 1's `serverLogExcerpt` and
   * `diagnostics` bundle land here as markdown-ish text), this client only
   * folds it into the issue description.
   */
  diagnosticsSummary?: string;
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

/** Title = truncated first line of the message. */
function buildTitle(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? message;
  return truncate(firstLine, MAX_TITLE_LEN) || 'Feedback submission';
}

/** Description = full message + a rendered identity block + diagnostics + attachments. */
function buildDescription(input: CreateFeedbackIssueInput): string {
  const sections = [input.message.trim()];

  const identityLines: string[] = [];
  if (input.reporterEmail) {
    identityLines.push(
      `Reporter: ${input.reporterName ? `${input.reporterName} ` : ''}<${input.reporterEmail}>`
    );
  } else if (input.reporterName) {
    identityLines.push(`Reporter: ${input.reporterName}`);
  }
  if (input.contact) identityLines.push(`Contact: ${input.contact}`);
  if (input.route) identityLines.push(`Route: ${input.route}`);
  if (identityLines.length > 0) {
    sections.push(['---', '**Submitted by**', ...identityLines].join('\n'));
  }

  if (input.diagnosticsSummary) {
    sections.push(['---', '**Diagnostics**', input.diagnosticsSummary].join('\n'));
  }

  if (input.attachmentUrls && input.attachmentUrls.length > 0) {
    sections.push(
      ['---', '**Attachments**', ...input.attachmentUrls.map((url) => `- ${url}`)].join('\n')
    );
  }

  return sections.join('\n\n');
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
