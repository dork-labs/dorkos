/**
 * Minimal, write-capable Linear client for the feedback intake pipeline
 * (feedback-pipeline, decision 260803-205035).
 *
 * Raw GraphQL over `fetch` — no `@linear/sdk`. This matches the style of the
 * only existing Linear client in the repo, the read-only, user-supplied-key
 * extension at `apps/server/src/core-extensions/linear-issues/server.ts`:
 * same `gql()` helper shape (here `linearGraphQL` in
 * `lib/feedback/linear-graphql.ts`), same `Authorization: <apiKey>` header (the
 * raw key, NOT `Bearer <key>` — Linear's personal/app API keys go in the header
 * unprefixed). This repo has never taken the `@linear/sdk` dependency and one
 * small mutation doesn't justify starting.
 *
 * **Labels**: the kind a reporter picked is recorded as a `reported/*` label,
 * resolved by name in `lib/feedback/reported-labels.ts` — never as `Bug` or
 * `Feature`, which are triage's own verdict vocabulary. No priority is set:
 * priority is a judgment about our plan, and a form cannot know the backlog.
 *
 * Unlike that extension (a user-supplied key read from per-install secret
 * storage), this client is authenticated with a **server-only key from site
 * env** (`LINEAR_API_KEY`), because feedback intake runs unattended on every
 * submission, not on a per-user configured integration.
 *
 * **That key needs the `write` scope**, not merely `issues:create`.
 * {@link uploadScreenshot} calls the `fileUpload` mutation, which Linear gates
 * on `write` — verified empirically on 2026-09-09, and contrary to Linear's
 * docs, which describe `issues:create` as covering issues "and their
 * attachments". The reasoning is recorded on that function; do not narrow the
 * key on the strength of the documentation.
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

import { linearGraphQL } from './linear-graphql';
import { reportedLabelIdsForKind } from './reported-labels';

/**
 * Cap on the raw screenshot `PUT`. Every Linear leg of a submission runs inside
 * the app's own 10s abort on `POST /api/feedback`, so an unbounded one does not
 * merely hang — it lets that abort fire while this route keeps going, and the
 * reporter is told the send failed while the Neon row and the Linear issue both
 * exist. They then refile, and triage gets a duplicate. The GraphQL legs carry
 * their own caps (`lib/feedback/linear-graphql.ts`, plus the tighter one the
 * label lookup passes).
 */
const SCREENSHOT_PUT_TIMEOUT_MS = 6_000;

/** Submission kind, mirrors `FeedbackKind` in `db/feedback-schema.ts`. */
export type FeedbackIssueKind = 'feedback' | 'bug' | 'idea';

/** Input to {@link createFeedbackIssue}. */
export interface CreateFeedbackIssueInput {
  /** Drives the `reported/*` label (see `lib/feedback/reported-labels.ts`). */
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
  /**
   * An opt-in screenshot travelling inline with the submission. This module
   * owns getting it into Linear's asset store (see {@link uploadScreenshot})
   * and embedding it — callers pass the raw `data:` URL and nothing else.
   */
  screenshot?: { dataUrl: string };
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

interface IssueCreateData {
  issueCreate?: {
    success: boolean;
    issue?: { id: string; identifier: string; url: string };
  };
}

interface FileUploadData {
  fileUpload?: {
    success: boolean;
    uploadFile?: {
      uploadUrl: string;
      assetUrl: string;
      headers?: Array<{ key: string; value: string }>;
    };
  };
}

const FILE_UPLOAD_MUTATION = `
  mutation FeedbackScreenshotUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile {
        uploadUrl
        assetUrl
        headers {
          key
          value
        }
      }
    }
  }
`;

/**
 * File extension per accepted image type. Linear derives nothing from the
 * filename, but a correct extension is what makes the asset open sensibly when
 * a triager downloads it.
 */
const SCREENSHOT_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * The accepted `data:` URL shape. Deliberately STRICTER than the intake
 * route's Zod regex rather than a mirror of it: that one anchors only the
 * prefix, while this also requires a non-empty, single-line payload (`.` does
 * not match a newline), because this is the value actually about to be decoded
 * and uploaded. Anything it rejects flows into the same degradation path as a
 * failed upload, so the extra strictness costs a screenshot, never a report.
 */
const SCREENSHOT_DATA_URL_RE = /^data:(image\/(?:webp|png|jpeg));base64,(.+)$/;

/**
 * Leading bytes each accepted type must actually begin with. The declared
 * media type comes from the submitter, and it is what we hand Linear as
 * `contentType`; checking it against the bytes keeps a mislabeled (or
 * deliberately disguised) payload from being stored under a type it is not.
 * WebP is the two-part case — `RIFF` then a 4-byte length then `WEBP` — so it
 * carries an offset per signature rather than a single prefix.
 */
const SCREENSHOT_MAGIC_BYTES: Record<string, Array<{ offset: number; bytes: number[] }>> = {
  // "RIFF" .... "WEBP"
  'image/webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
  // \x89 P N G
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  // JPEG SOI + first marker
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
};

/**
 * Whether `bytes` actually begins with the signature for `contentType`.
 *
 * @param bytes - The decoded image bytes.
 * @param contentType - The media type the submitter declared.
 */
function magicBytesMatch(bytes: Buffer, contentType: string): boolean {
  const signatures = SCREENSHOT_MAGIC_BYTES[contentType];
  if (!signatures) return false;
  return signatures.every(({ offset, bytes: expected }) =>
    expected.every((byte, index) => bytes[offset + index] === byte)
  );
}

/**
 * Upload a screenshot to Linear's own asset store and resolve its `assetUrl`.
 *
 * Two steps, both required by Linear: the `fileUpload` mutation reserves a slot
 * and hands back a short-lived signed `uploadUrl` plus the exact headers that
 * signature covers, then the raw bytes go up with a `PUT` carrying those
 * headers. Every returned header is applied, because the signature is computed
 * over them and dropping one is a 403 from the storage backend rather than a
 * Linear error. They go into a `Headers`, not a plain object, specifically so
 * that a returned `content-type` REPLACES the seeded one instead of joining it:
 * `Headers` appends on duplicate names, and two content-type values is the same
 * silent 403 by a different route.
 *
 * **This needs an API key with the `write` scope.** Linear's own docs say the
 * `issues:create` scope "allows creating new issues and their attachments",
 * which reads as though a create-issues key would do — it does not.
 * Empirically, on 2026-09-09, `fileUpload` with a create-issues-scoped key is
 * refused with `Invalid scope: 'write' required`, while `issueCreate` and
 * `attachmentCreate` both succeed with that same key. Do not narrow
 * `LINEAR_API_KEY` back to `issues:create` on the strength of the docs.
 *
 * Throws on any failure (malformed data URL, GraphQL error, unsuccessful
 * mutation, failed PUT). {@link createFeedbackIssue} catches it — a screenshot
 * must never cost the reporter their submission.
 *
 * @param apiKey - The `write`-scoped Linear API key (raw, unprefixed).
 * @param dataUrl - `data:image/(webp|png|jpeg);base64,<payload>`.
 * @returns The workspace-private `assetUrl` to embed in the issue description.
 */
export async function uploadScreenshot(apiKey: string, dataUrl: string): Promise<string> {
  const match = SCREENSHOT_DATA_URL_RE.exec(dataUrl);
  if (!match) {
    throw new Error('screenshot is not a supported base64 image data URL');
  }
  const [, contentType, base64] = match;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('screenshot decoded to zero bytes');
  }
  if (!magicBytesMatch(bytes, contentType)) {
    throw new Error('screenshot bytes do not match declared type');
  }

  const json = await linearGraphQL<FileUploadData>(apiKey, FILE_UPLOAD_MUTATION, {
    contentType,
    filename: `feedback-screenshot.${SCREENSHOT_EXTENSIONS[contentType] ?? 'png'}`,
    // Linear validates this against what actually arrives, so it must be the
    // DECODED byte length, not the length of the base64 text.
    size: bytes.byteLength,
  });

  const uploadFile = json.data?.fileUpload?.success ? json.data.fileUpload.uploadFile : undefined;
  if (!uploadFile) {
    throw new Error('Linear fileUpload did not report success');
  }

  // `Headers.set` replaces case-insensitively, so a returned `content-type` in
  // any casing overwrites the seeded one. A plain object would keep both keys
  // and `fetch` would send them joined.
  const headers = new Headers({ 'content-type': contentType });
  for (const header of uploadFile.headers ?? []) {
    headers.set(header.key, header.value);
  }

  const putRes = await fetch(uploadFile.uploadUrl, {
    method: 'PUT',
    headers,
    body: bytes,
    signal: AbortSignal.timeout(SCREENSHOT_PUT_TIMEOUT_MS),
  });
  if (!putRes.ok) {
    throw new Error(`screenshot upload failed: ${putRes.status}`);
  }

  return uploadFile.assetUrl;
}

/** Truncate a string to `max` chars, appending an ellipsis when cut. */
function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

const MAX_TITLE_LEN = 80;
/**
 * Cap on the failure reason folded into the Attachments section when a
 * screenshot upload fails. The reason is our own error text, not user input,
 * but it can carry a signed URL or a provider's multi-line body — one bounded
 * line keeps the section readable and the parsing contract intact.
 */
const MAX_SCREENSHOT_FAILURE_REASON_LEN = 200;
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
function buildDescription(input: CreateFeedbackIssueInput, screenshotLine?: string): string {
  const sections = [input.message.trim()];

  const identityLines: string[] = [];
  const reporterLine = buildReporterLine(input);
  if (reporterLine) identityLines.push(reporterLine);
  if (input.contact) identityLines.push(`Contact: ${oneLine(input.contact)}`);
  // One `Key: value` line each — a triaging agent parses these without
  // guessing. `Kind:` is also the fallback record of what the reporter picked
  // when the `reported/*` label could not be resolved.
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

  // The screenshot leads the Attachments section — it is the thing a triager
  // wants first, and its markdown embed renders an inline preview. It also
  // creates the section on its own, for a submission whose only attachment is
  // the image. `screenshotLine` is either that embed or the honest one-line
  // note that the upload failed (see `createFeedbackIssue`).
  const attachmentLines = [
    ...(screenshotLine ? [screenshotLine] : []),
    ...(input.attachmentUrls ?? []).map((url) => `- ${url}`),
  ];
  if (attachmentLines.length > 0) {
    sections.push(['---', '**Attachments**', ...attachmentLines].join('\n'));
  }

  const description = sections.join('\n\n');
  if (description.length <= MAX_DESCRIPTION_LEN) return description;
  return description.slice(0, MAX_DESCRIPTION_LEN - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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
 *
 * The ONE exception is an attached screenshot: a failed upload is caught here
 * and degrades to a note in the Attachments section, because losing the
 * picture is a far smaller harm than losing the report.
 */
export async function createFeedbackIssue(
  input: CreateFeedbackIssueInput
): Promise<CreateFeedbackIssueResult | null> {
  const apiKey = env.LINEAR_API_KEY;
  const teamId = env.LINEAR_TEAM_ID;
  if (!apiKey || !teamId) return null;

  // The upload has to finish before `issueCreate`, because its `assetUrl` goes
  // into the description. A failure here is NOT allowed to cost the reporter
  // their issue: the reason is recorded in the Attachments section and the
  // create proceeds. That is also why the error is logged rather than
  // rethrown — the caller's own catch would leave the row `received` with no
  // Linear issue at all, over a picture.
  // Started before the upload so the two independent network legs overlap
  // inside the route's budget. It never rejects — a lookup that fails resolves
  // to no label, because a report is worth more than its tag.
  const labelIdsPromise = reportedLabelIdsForKind(apiKey, teamId, input.kind);

  let screenshotLine: string | undefined;
  if (input.screenshot) {
    try {
      const assetUrl = await uploadScreenshot(apiKey, input.screenshot.dataUrl);
      screenshotLine = `![Screenshot](${assetUrl})`;
    } catch (error) {
      const reason = truncate(
        oneLine(error instanceof Error ? error.message : String(error)),
        MAX_SCREENSHOT_FAILURE_REASON_LEN
      );
      console.error('[feedback/linear] screenshot upload failed (issue still created)', { reason });
      screenshotLine = `Screenshot: upload failed (${reason})`;
    }
  }

  const json = await linearGraphQL<IssueCreateData>(apiKey, ISSUE_CREATE_MUTATION, {
    input: {
      teamId,
      projectId: env.LINEAR_FEEDBACK_PROJECT_ID || undefined,
      title: buildTitle(input.message),
      description: buildDescription(input, screenshotLine),
      // A COMPLETE label set, which is the only form the exclusive `reported`
      // group tolerates — adding a second member to an issue that already has
      // one is rejected outright, never swapped (see `reported-labels.ts`).
      labelIds: await labelIdsPromise,
    },
  });

  const result = json.data?.issueCreate;
  if (!result?.success || !result.issue) {
    throw new Error('Linear issueCreate did not report success');
  }

  return { issueId: result.issue.id, issueUrl: result.issue.url };
}
