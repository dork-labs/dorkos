# Feedback pipeline — specification

Source: `specs/feedback-pipeline/01-ideation.md`. Four PRs, in dependency order:
**A** (submission payload: diagnostics + identity) → **B** (site intake: Neon +
Linear) can proceed in parallel with A once the payload shape is frozen → **C**
(dialog UI + entry points + GitHub demotion) depends on A → **D** (tracking +
email) depends on B.

## Part 1 — Submission payload (PR A)

### `FeedbackSubmission` grows, `.strict()` stays

`packages/shared/src/telemetry-events.ts`:

```ts
export const FeedbackSubmissionSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS_ALL), // 'feedback' | 'bug' | 'idea'
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    diagnostics: FeedbackDiagnosticsSchema.optional(),
    transcriptExcerpt: z.string().max(MAX_TRANSCRIPT_LEN).optional(), // opt-in, client-truncated
    screenshotUploadId: z.string().min(1).max(128).optional(), // ref into the existing upload path
  })
  .strict();
```

`FeedbackDiagnosticsSchema` (new, bounded, allowlist-shaped like the existing
`FeedbackReport`/`sanitizeFlags` pair):

```ts
export const FeedbackDiagnosticsSchema = z
  .object({
    clientReport: z
      .object({
        version: z.string().max(64),
        platform: z.string().max(64),
        runtimes: z.array(z.string().max(64)).max(16),
        flags: z.record(z.string(), z.union([z.boolean(), z.string().max(64)])),
      })
      .strict(),
    breadcrumbs: z.array(BreadcrumbSchema).max(MAX_BREADCRUMBS).optional(),
    serverLogExcerpt: z.string().max(MAX_LOG_EXCERPT_LEN).optional(),
  })
  .strict();

const BreadcrumbSchema = z
  .object({
    at: z.string().datetime(),
    kind: z.enum(['console_error', 'console_warn', 'query_error', 'sse_disconnect']),
    message: z.string().max(300),
  })
  .strict();
```

- `MAX_TRANSCRIPT_LEN`, `MAX_LOG_EXCERPT_LEN`, `MAX_BREADCRUMBS` are new
  exported constants alongside the existing `MAX_FEEDBACK_*` ones.
- `clientReport` reuses `buildClientReport`'s existing safe subset (it already
  excludes paths/tokens/hostnames) — this is the same object the GitHub path
  builds today, just riding the in-app submission instead of a URL.
- `breadcrumbs` is a client-only ring buffer (new: `apps/client/src/layers/shared/lib/breadcrumbs.ts`),
  capped at `MAX_BREADCRUMBS` (50), populated from: `window.addEventListener('error'/'unhandledrejection')`
  is already covered by `client-error-reporter.ts` — breadcrumbs additionally hook
  `console.error`/`console.warn` (wrapped, not replaced — call the original), the
  `QueryCache`/`MutationCache` `onError` handlers already in `query-client.ts`, and
  SSE disconnect events from the durable session stream. Never persisted; in-memory only, cleared on reload.
- `serverLogExcerpt` is built **server-side**, not sent by the client. The
  route reads it from `getLogDir()` (see Part 2) after validating the rest of
  the submission — the client never touches the log file.

### The route-local mirror (site) must accept the superset first

Per ADR-0235, `apps/site/src/app/api/telemetry/events/route.ts` keeps a
route-local mirror of the feedback schemas. **This PR updates both the shared
registry and the site mirror in the same commit**, and the site half must
land and deploy _before_ any cockpit release starts sending the new fields —
otherwise the ingest's `.strict()` mirror rejects the whole event (this ingest
drops non-matching events silently, so the failure mode is "quietly does
nothing," not an error the sender would see). Landing order for this PR:
merge → confirm the Vercel deploy is live → only then is it safe to also cut
a cockpit release that sends the new fields. Practically: this repo's own
`main` is what deploys the site, so merging PR A to `main` deploys the new
mirror immediately; the cockpit fields only start being _sent_ once PR C
merges and a release goes out, which is naturally after A is live. No manual
sequencing needed beyond "merge order = A, B, C" — call this out in PR A's
description anyway so a reviewer doesn't need to reconstruct it.

### Identity attachment

New: `apps/server/src/routes/feedback.ts` resolves the requester's identity
**server-side**, never trusts a client-supplied name/email:

```ts
const requestUser = res.locals.user; // set by sessionGate when auth.enabled
const identity = requestUser ? await resolveFeedbackIdentity(requestUser.userId) : undefined;
```

`resolveFeedbackIdentity` (new, `services/core/feedback-reporter.ts` or a
small sibling) does the one extra lookup the auth explorer identified — either
a direct Drizzle read of `user.email`/`user.name` by id, or a fresh
`auth.api.getSession()` call reusing `getAuth()`. Prefer the direct Drizzle
read: it's one query against a table already keyed by the id the gate
verified, versus re-deriving a session from headers a second time.

`SendFeedbackOptions` gains `identity?: { userId: string; email: string; name: string }`,
forwarded into the built event's properties as `reporterEmail`/`reporterName`
— new optional fields on `FeedbackSubmittedProperties`/`FeatureRequestedProperties`
(shared + site mirror, both `.optional()`), separate from the free-text `contact`
field so downstream consumers can tell "typed by the user" from "resolved from
their account."

When auth is off or no session exists, `identity` is `undefined` and behavior
is unchanged from today (pseudonymous `instanceId` + optional typed `contact`).

**Client-side visibility is mandatory, not just a server nicety.** The dialog
(PR C) shows "Sending as {email}" whenever `useCurrentUser()` returns a user,
with a toggle to send anonymously instead (which the client signals by simply
omitting reliance on the account — the server still resolves identity from
the verified session unless the request is made without credentials, which
the dialog cannot easily do for same-origin fetches). Resolve this exact
mechanic at implementation time: either (a) the toggle suppresses the
_display_ only and identity always attaches when logged in (simplest, and
arguably fine — the user is on their own machine, submitting to their own
team), or (b) the route accepts an explicit `anonymous: true` flag in the
body that skips the identity lookup even when a session exists. Recommend
(a) for v1: simpler, and "anonymous while logged into your own local
instance" is a low-value guarantee to engineer for. Flag doc updated to
match whichever is chosen.

### `DirectTransport` (Obsidian) degradation

`apps/client/src/layers/shared/lib/direct/feedback-methods.ts` has no server
to source `serverLogExcerpt` from and no session gate to resolve identity
against. Its `sendFeedback` sends `diagnostics.clientReport` and
`breadcrumbs` only (both client-only), omits `serverLogExcerpt`, and posts
straight to the owned ingest as it does today. No identity attachment in this
transport for v1 — Obsidian has no DorkOS account concept.

### Tests to update (per the explorer's map)

`packages/shared/src/__tests__/feedback-events.test.ts` (new schema shape),
`apps/server/src/routes/__tests__/feedback.test.ts` +
`.../services/core/__tests__/feedback-reporter.test.ts` (identity resolution,
log-excerpt gathering), `apps/site/.../telemetry/events/__tests__/route.test.ts`
(mirror superset), `packages/test-utils/src/mock-factories.ts` (extend the
`sendFeedback` mock's accepted shape — no behavior change needed, just typing).

---

## Part 2 — Server log excerpt (PR A)

New function in `apps/server/src/lib/logger.ts` (or a sibling
`log-excerpt.ts` to keep `logger.ts` focused): `getRecentLogExcerpt(maxLines,
maxAgeMs)`. Reads from `getLogDir()`, tails the current day's file (and the
immediately-prior rotated file when the tail is thin — the rotation-boundary
case the explorer flagged), filters to `warn`+ severity by default, and joins
into a bounded string under `MAX_LOG_EXCERPT_LEN`.

**Scrubbing is mandatory before this ever leaves the process.** Log lines are
operator-facing today and not guaranteed PII-clean (unlike the `$exception`
allowlist). Reuse `redactPaths`/`redactTokens` from
`packages/shared/src/error-report.ts` (already proven scrubbers, same
discipline as crash reports) rather than writing a second redactor — run the
joined excerpt through them before it's attached to `diagnostics`. This
function lives in the feedback route handler (Part 1), called only when
`kind === 'bug'` and the request completes the rest of validation first, so a
malformed submission never triggers a log read.

---

## Part 3 — Site intake: Neon + Linear (PR B)

### Neon table: `feedback_submission`

New schema module `apps/site/src/db/feedback-schema.ts`, re-exported from
`schema.ts`, following the isolation convention every existing table uses
(explicit doc-comment boundary statement, asserted by
`apps/site/src/db/__tests__/schema.test.ts`):

```ts
export const feedbackSubmission = pgTable('feedback_submission', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: text('instance_id').notNull(), // the per-install pseudonymous id; NOT an FK
  kind: text('kind', { enum: ['feedback', 'bug', 'idea'] }).notNull(),
  message: text('message').notNull(),
  contact: text('contact'),
  reporterEmail: text('reporter_email'), // resolved server-side identity, if any — NOT an FK to `user`
  reporterName: text('reporter_name'),
  route: text('route'),
  surface: text('surface', { enum: ['cockpit', 'site'] }).notNull(),
  hasScreenshot: boolean('has_screenshot').notNull().default(false),
  hasTranscript: boolean('has_transcript').notNull().default(false),
  linearIssueId: text('linear_issue_id'),
  linearIssueUrl: text('linear_issue_url'),
  status: text('status', {
    enum: ['received', 'triaged', 'in_progress', 'shipped', 'closed'],
  })
    .notNull()
    .default('received'),
  shippedVersion: text('shipped_version'), // filled by the webhook handler when Linear marks it done
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

Isolation comment (mirroring `audit_log`'s reasoning): `instanceId`,
`reporterEmail`/`reporterName`, and `linearIssueId` are plain text, never
foreign keys — a GDPR erasure of a `user` row, a rotated Linear issue, or a
regenerated instance id must never cascade-delete or orphan a feedback
record. `message`/`contact`/`reporterEmail` are the volunteered free text
this table exists to hold (same exemption `FeedbackSubmittedProperties`
already documents); this table does not carry the diagnostics bundle itself
(logs/breadcrumbs/screenshot) — only enough to know one was attached
(`hasScreenshot`/`hasTranscript` booleans) plus whatever Linear ends up
holding as the actual attachment. Screenshot bytes and log/transcript
excerpts go to Linear as attachments/description content, not into Neon —
this keeps the durable table small and keeps the heavier, more identifying
content in the same system that already handles issue attachments, rather
than growing a second blob store.

**Migration timing**: generate with `drizzle-kit generate` and commit
immediately before merging this PR (not earlier in the branch), per the
migration-ledger gotcha. Rebase onto latest `main` right before generating.

**DB-drift CI gate**: confirm before merge that `scripts/assert-migrations-current.sh`
/ the `db-check.yml` workflow actually covers `apps/site`'s Drizzle output
(the explorer flagged this as unconfirmed, wired by path to `packages/db`
which is SQLite). If it doesn't cover the site's Neon migrations, that's a
pre-existing gap worth a one-line follow-up ticket, not something this PR
needs to fix — but it must be verified, not assumed, before relying on it as
a safety net for this table.

### Linear client: new, minimal, write-capable

New module `apps/site/src/lib/linear.ts`. Style: raw GraphQL over `fetch`
(matches the one existing Linear client's dependency-free approach; no
`@linear/sdk` — this repo has never taken that dependency and one small
mutation doesn't justify starting). Server-side API key via new env var
`LINEAR_API_KEY` (added to `apps/site/src/env.ts` and
`contributing/environment-variables.md`), unlike the existing user-supplied-key
extension client.

```ts
export async function createFeedbackIssue(input: {
  kind: 'feedback' | 'bug' | 'idea';
  message: string;
  reporterEmail?: string;
  reporterName?: string;
  contact?: string;
  route?: string;
  diagnosticsSummary?: string; // rendered markdown block: version/platform/runtimes/route
  attachmentUrls?: string[]; // screenshot, log excerpt, transcript excerpt — pre-uploaded
}): Promise<{ issueId: string; issueUrl: string } | null>;
```

Mutation creates an issue in a dedicated **"Feedback intake" Linear project**
under team `DOR` (new project, created once by hand — not by this code),
label `kind` → `type/bug` / `type/feature` / (plain, for general feedback,
no extra label). Title is a truncated first line of `message`; description
is the full message plus a rendered diagnostics block and reporter
identity/contact if present. `graphql-request`-free, same `gql()` helper
shape as the existing extension client, but this one throws on failure since
the caller (the route) decides how to degrade — never silently swallowed
inside the client itself.

**Attachments.** Screenshot bytes arrive via the existing client upload path
(Part 1 references `screenshotUploadId`) — resolve exactly how that upload
lands somewhere Linear's issue-attachment API can reference (a signed URL,
per Linear's file-upload flow) during implementation; if the existing upload
path returns a durable public-ish URL, pass it straight through, otherwise a
short-lived re-upload step is needed. This is an implementation-time decision
best made by the PR B agent after reading the actual upload-methods code,
not pre-decided here.

### Route: `POST /api/feedback` on the site (new, `nodejs` runtime)

Not the existing `/api/telemetry/events` edge route — that one is explicitly
"no Neon table" by design and stays PostHog-only for usage events. This is a
**new, additional** site route the cockpit's server forwards to (the cockpit's
own `apps/server/src/services/core/feedback-reporter.ts` gains a second
target: it keeps sending the existing PostHog-shaped event to
`/api/telemetry/events` for metrics continuity, and additionally posts the
richer submission to this new route for durable storage + Linear). `nodejs`
runtime because Linear issue creation and (Part 4) HMAC webhook verification
both want Node crypto/timing, and this route isn't the hot, high-volume path
`/api/telemetry/events` is.

Flow: validate with a site-local Zod mirror of the submission shape → insert
`feedback_submission` row (`status: 'received'`) → call `createFeedbackIssue`
→ on success, update the row with `linearIssueId`/`linearIssueUrl`,
`status: 'triaged'` → respond `{ ok: true, id: <row id> }` (the row id is
the tracking id, returned to the client so the dialog can show/link it). If
Linear creation fails, the row stays `status: 'received'` with no Linear
id — **not a caller-visible failure**: the honest-toast contract stays
"received" as long as the Neon insert succeeded (durable storage is the
real guarantee; Linear is best-effort and retryable out-of-band later if
needed, e.g. a cron sweep for `status='received' AND linear_issue_id IS NULL`
older than N minutes — worth a follow-up ticket, not this PR).

Same guardrails as the existing ingest, adapted (no new rate-limit infra):
honeypot field, Zod strict caps, and a size cap on the whole body
(screenshot rides a separate upload, so this route's body stays small).

### Tests

New: `apps/site/src/app/api/feedback/__tests__/route.test.ts` (insert +
Linear success/failure paths, honest status on Linear failure), Neon schema
isolation test extension in `db/__tests__/schema.test.ts`, `lib/__tests__/linear.test.ts`
(mutation shape, error propagation — mock `fetch`).

---

## Part 4 — Tracking + email (PR D)

### Linear webhook receiver

New route `apps/site/src/app/api/webhooks/linear/route.ts`, `nodejs` runtime.
Verifies Linear's HMAC signature (new: `LINEAR_WEBHOOK_SECRET` env var) —
this repo has no existing webhook-verification code, so this is written
fresh using Node's `crypto.timingSafeEqual` against an HMAC-SHA256 of the
raw body, matching Linear's documented scheme. On a verified `Issue`
`update` event where `issue.id` matches a `feedback_submission.linearIssueId`,
map Linear's workflow state to the four cockpit-visible statuses
(`triaged`/`in_progress`/`shipped`/`closed` — a state-name→status mapping
table, not 1:1 with Linear's own states) and update the row. When the
mapped status is `shipped`, also capture `shippedVersion` if resolvable
(from a Linear custom field or the milestone/cycle name — confirm what's
actually available at implementation time) and trigger the "shipped" email
if a `reporterEmail`/`contact` exists on the row.

### Public status endpoint + page

`GET /api/feedback/[id]/route.ts` (edge is fine here — read-only, no
secrets) returns `{ status, kind, createdAt, shippedVersion? }` for a
`feedback_submission` row — deliberately **not** the message, contact, or
Linear internals (never leak Linear titles/comments/assignee). A thin page
`apps/site/src/app/feedback/[id]/page.tsx` renders this for the emailed
tracking link.

### Cockpit tracking view

New client feature, name TBD at the design checkpoint (task #3) — not "My
Reports." Lists submissions for the current `instanceId` via
`GET /api/feedback/mine?instanceId=...` proxied through the local server
(same pattern as other site-backed reads) or called directly from the
client depending on what the design checkpoint settles for placement
(dialog vs. dedicated view — open question #3 from the ideation doc).
Status badges use the same four-state vocabulary as the public endpoint.

### Resend emails

New functions in `apps/site/src/lib/mailer.ts` (the established single
seam): `sendFeedbackReceipt(to, trackingUrl)` and
`sendFeedbackShipped(to, { message, shippedVersion, changelogUrl })`. Follow
the `resend-segment.ts` pattern for anything that touches Resend contacts;
these are plain transactional sends like `sendVerificationEmail`, not
contact/segment writes, so they're simpler — lazy client, no-op-safe only
in the sense that a missing `RESEND_API_KEY` should not crash the webhook
handler (catch and log, same posture as every other best-effort external
call in this pipeline). Copy follows `writing-for-humans`: one clear
sentence, a link, no marketing language, explicit scoped-consent line
("We'll only email you about this report").

Trigger points: receipt sends from the `POST /api/feedback` route
(Part 3) right after a successful Neon insert, when `reporterEmail` or
`contact` (if it looks like an email — reuse existing validation, don't
invent a new heuristic) is present. Shipped sends from the webhook handler
above.

### Tests

`apps/site/src/lib/__tests__/mailer.test.ts` (new functions), webhook route
test (signature verification reject/accept, status mapping, email trigger),
`feedback/[id]` route + page tests.

---

## Part 5 — Client entry points + GitHub demotion (PR C)

### Dialog changes

`FeedbackDialog.tsx` gains: an identity line ("Sending as {email}" /
"Sending anonymously") when `useCurrentUser()` resolves, a diagnostics
section (default-on checkbox for `kind === 'bug'`, off for other kinds,
with a "what's included" expander showing the actual `clientReport` +
breadcrumb count + whether a log excerpt will be attached — text only, no
live preview of log content needed since it's server-gathered), a
screenshot drop zone (paste `ClipboardEvent` + `<input type=file>`,
client-side downscale/compress before upload via the existing upload path),
and a transcript checkbox that only appears when `sessionId` is resolvable
from the current route, defaulting off, with a short preview (last N turns,
truncated) before send.

### Entry points

- **Command palette**: `palette-contributions.ts` gains (or repoints) an
  `openFeedback` action alongside the existing `reportIssue` — `reportIssue`
  stays wired to GitHub but drops out of the default/quick-actions surface
  per the demotion below; `openFeedback` becomes the primary palette entry,
  dispatched in `use-palette-actions.ts`.
- **Error toast action**: `query-client.ts`'s `QueryCache`/`MutationCache`
  `onError` handlers add a `toast.error(msg, { action: { label: 'Report',
onClick: () => openFeedbackDialog({ kind: 'bug', prefill: error }) } })`.
  Needs a small pub/sub or a Zustand slice to open the dialog from outside
  React context (the toast handler isn't a component) — check whether one
  already exists for other cross-cutting dialog opens before adding one.
- **App-crash boundary**: `app-crash-fallback.tsx` gets a "Report this
  crash" button that pre-fills kind=bug, message stubbed from
  `error.message`, and the stack trace folded into `diagnostics` — this is
  the highest-value hook per the explorer's read (it already holds
  `error`/`stack` and today only offers "Reload").
- **Help menu**: `HelpMenu.tsx` reorders — "Send feedback" / "Report a
  bug" (in-app, both now point at the same dialog with `kind` preset) stay
  primary; the two GitHub items collapse under a single "Report on
  GitHub…" secondary entry (or a small submenu — resolve exact shape at
  the design checkpoint), visually demoted (smaller/muted, below a
  separator).

### GitHub demotion, precisely

Per instruction: GitHub stays available but becomes secondary, and is
**removed from the command palette's default/quick-action set** (the
`case 'reportIssue'` handler and `palette-contributions.ts` entry are not
deleted — `useReportIssue`/`buildIssueUrl`/`sanitizeFlags` are still used by
the CLI's `dorkos feedback` command and remain a legitimate path — but the
palette contribution for it is removed or moved out of the searchable
default set). Confirm at implementation time whether "not in the command
palette" means fully removed from `PALETTE_QUICK_ACTIONS`/`PALETTE_FEATURES`
or demoted to a lower `priority` — the instruction was explicit ("should
not be in the command palette"), so: **removed**, not just deprioritized.

### Dangling-reference check (for the reviewer)

Nothing about `useReportIssue`, `buildIssueUrl`, `sanitizeFlags`, or the
GitHub issue templates is deleted in this round — only the palette
contribution and the help-menu prominence change. The CLI feedback command
and its tests are unaffected.

---

## Rollout order (binding)

1. **PR A** merges to `main` (shared schema + site mirror update deploy
   together; server route changes deploy with the next server/CLI release —
   no forced coupling since the server only _reads_ the new optional fields
   when present).
2. **PR B** merges (Neon table, Linear client, new site route). Can start
   in parallel with A once the payload shape in Part 1 is frozen, since B's
   route is additive and doesn't depend on A's client-side breadcrumbs.
3. **Ops** (task #8): provision `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`,
   the Feedback-intake Linear project/labels, confirm `RESEND_API_KEY` is
   already set (it predates this work).
4. **PR C** merges (dialog + entry points + demotion) — depends on A's
   schema being live.
5. **PR D** merges (webhook + tracking + email) — depends on B's Linear
   issue ids existing to mirror against, and on ops having the webhook
   secret provisioned.

## Explicitly deferred (from the ideation doc's non-goals)

Screenshot annotation/redaction, one-click DOM/Electron capture,
point-at-the-element crosshair reporting, DorkBot-as-intake. Each is a
natural follow-up once this pipeline is live and gets filed as a Linear
ticket during closeout (task #9), not designed further here.
