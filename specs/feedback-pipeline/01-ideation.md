# Feedback pipeline — ideation

## Problem

The in-app "Send feedback" dialog (DOR-317) works but is thin at both ends:

- **Thin submission.** It carries only a typed message, an optional free-text contact string, and the current route. No diagnostics, no way to attach a screenshot, no way to attach the session transcript that's already open, no automatic identity even though the user may be logged in.
- **Thin destination.** Submissions land as PostHog events (`feedback_submitted` / `feature_requested`) and nowhere else. PostHog is a metrics store, not a queue: no triage state, no notification, no way to mark something handled, and a volunteered contact email is only visible if someone goes querying events by hand. `apps/site`'s own ingest route says as much in its header comment: _"there is no Neon table... Neon stays system-of-record only for install + heartbeat sinks."_ There is no durable record of a submission anywhere.
- **Thin discoverability.** The dialog is one entry among several in a small help-menu dropdown, with the two GitHub options ("Report a bug on GitHub" / "Request a feature on GitHub") given equal visual weight even though they're the secondary, developer-facing path (DOR-317's original ADR, 260711-143626, mostly designed for them).
- **No loop closure.** A user (including Dorian, who dogfoods this daily) who files a report has no way to know it went anywhere, was seen, or shipped.

## Vision

Feedback becomes a first-class, always-available capability of the cockpit — not a buried form. Concretely:

1. **Richer submissions.** A bug report should be able to carry, on top of the message: a sanitized client/server diagnostics bundle (version, platform, runtimes, route, recent breadcrumbs, a scrubbed slice of server logs), the current session's id/runtime, an optional screenshot (paste, upload, or later a one-click capture), an optional session transcript (opt-in, previewed before send), and — when the user is authenticated — their account identity (name/email), shown plainly rather than silently attached.
2. **A real destination.** Submissions dual-write: a durable Neon row (system of record, keyed by an id the reporter can use to check status) and a Linear issue (so it enters the same `/flow` triage machinery as every other piece of work), while still emitting the existing PostHog event for aggregate metrics. Linear becomes where the work actually gets done; Neon is what lets the pipeline answer "what happened to my report" without hitting the Linear API on every read.
3. **Loop closure.** A Linear webhook mirrors status changes back into the Neon row. The cockpit gets a small view listing the current install's own submissions (scoped by the anonymous per-install `instanceId`, no login required) with honest status. If the reporter provided (or is authenticated with) an email, Resend sends two emails: a receipt on submit, and a "this shipped" note on resolution — never a play-by-play of every status hop.
4. **Always available, not "when you remember it exists."** A global command-palette entry, an action on error toasts and the app-crash boundary (pre-filled with the error that just happened), and the existing help menu all open the same dialog. GitHub becomes the secondary, demoted option — present for people who want a public issue thread, not the default path.

## Why now

Dorian dogfoods this product every day and currently has no low-friction way to report what he hits, and no way to know what happened to what he already reported. The existing PostHog-only pipeline was reasonable for an early, low-volume alpha but is now the visible gap between "we collect feedback" and "we act on feedback."

## Constraints surfaced by due diligence (binding on the spec)

- **Identity policy reversal, done consciously.** ADR 260711-143626 (the original GitHub-rails decision) leans on DorkOS's "nothing phones home" posture; its sanitizer actively redacts emails as a leak risk. Attaching an authenticated user's email to a _feedback submission_ is a deliberate, user-visible reversal for this one flow only ("Sending as dorian@…", with an easy way to send anonymously) — not a change to the no-phone-home posture for telemetry generally. Pressing Send stays the consent boundary established by DOR-317/ADR 260713-143958.
- **Email is not on the request today.** The session gate (`session-gate.ts`) resolves `{ userId, credential }` and discards email; a route needs one extra lookup (or a fresh `auth.api.getSession` call) to get it. Auth is off by default in local single-user mode, so there is frequently no identity to attach at all — the pipeline must degrade to today's pseudonymous `instanceId` + optional typed contact.
- **No durable feedback storage exists anywhere.** This is new Neon schema in `apps/site`, following the existing per-domain-isolation convention (own comment block asserting no FK/join crosses into auth/telemetry tables, per `apps/site/src/db/__tests__/schema.test.ts`).
- **Linear write access is greenfield.** The only existing Linear client (`core-extensions/linear-issues/server.ts`) is read-only, user-supplied-key, raw GraphQL over `fetch`. Issue creation, a server-held API key, and webhook receipt/verification are all new.
- **No rate-limiting infrastructure exists in `apps/site`**, by explicit prior design (edge routes, no Redis/KV). The new Linear-writing endpoint needs Zod caps + honeypot + upsert-style guardrails in that same spirit, not new infra the site has deliberately avoided.
- **Migration-ledger risk is real and already bit DOR-187.** The feedback table's migration gets generated and committed immediately before merge, not early in the branch's life.
- **`DirectTransport` (Obsidian) has no local server.** Diagnostics that depend on `dorkHome` (server logs, transcript reads) have no source there; the feature must degrade gracefully rather than assume `HttpTransport`.
- **Diagnostics are more identifying than a typed message.** A server log slice or session transcript can carry far more than a person chose to type. These stay opt-in and previewed, distinct from the base "message + diagnostics bundle" which can be default-on for the `bug` kind because it's still bounded and scrubbed.
- **Attachments don't belong in the JSON payload.** Screenshots should ride the existing upload path (`transport/upload-methods.ts`), not inflate `FeedbackSubmission` with base64.

## Non-goals for this round

- Annotation/redaction tools on screenshots, and one-click DOM/Electron capture — valuable, but sequenced after paste/upload ships and proves the pipeline.
- DorkBot-as-intake ("file this as a bug" from chat) — the natural endgame, but the form-based pipeline is the reusable substrate it would call into; not built now.
- Enabling the dormant `dorkbot-triage` GitHub bot from ADR 260711-143626 — out of scope, unrelated to this pipeline.
- Point-at-the-element crosshair reporting — compelling, deferred to a later phase once the base attach-and-route pipeline is proven.

## Open questions for the design checkpoint

1. Naming for the "your submissions" view (explicitly not "My Reports" — reads as charts/dashboards).
2. Exact diagnostics-bundle contents shown in the preview, and whether "Include diagnostics" is a single checkbox or a short itemized list the user can partially uncheck.
3. Where the tracking view lives (a dialog opened from the help menu / palette vs. a route) and whether it needs to be reachable pre-auth.
4. Screenshot capture affordance for round one: paste/drop only, or also a "capture this window" button.
