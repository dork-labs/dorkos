---
id: 260713-143958
title: Two-plane, two-tier data collection strategy
status: accepted
created: 2026-07-13
spec: null
superseded-by: null
---

# 260713-143958. Two-plane, two-tier data collection strategy

## Status

Accepted. Amends [260711-141639](260711-141639-opt-in-observability-consent.md) (the consent
namespace, payload-documentation requirement, and no-PII tests stand; the heartbeat and install
channels move from opt-in to opt-out under the Tier 1 rules below).

## Context

DorkOS collects almost nothing today, and what it collects is fragmented. The marketing site just
launched consent-gated-everywhere PostHog (PR #265), which loses the 30–55% of visitors who never
accept a banner. The app's telemetry channels (`config.telemetry`: install, heartbeat,
errorReporting) are all opt-in and default-off, so we fly blind on adoption at the exact pre-launch
moment we most need signal. Feedback exists only as prefilled GitHub issues (developer-only), no
`identify()` call exists anywhere despite a working account system, error reporting is built but
dark (no DSN), and the existing OpenTelemetry tracing exports only to a local file. Research
(2026-07: privacy law across GDPR/ePrivacy/CCPA/TDPSA, PostHog capabilities, and the telemetry
practice of Next.js, VS Code, .NET, Astro, Homebrew, Nuxt, and GitHub CLI — see
`research/20260713_posthog_backend_ai_observability_headless_surveys.md`) shows a settled industry
pattern we were not following: anonymous aggregate telemetry is opt-out by default globally, while
anything identified is strict opt-in.

Our stance: collect as aggressively as the user's privacy, open-source norms, and the law allow —
with sophistication (vary by region, data source, and account state) instead of one-size-fits-all.

## Decision

We will organize all data collection into **two planes** and, within our own collection, **two
consent tiers**.

**Plane 1 — our collection** (data flows to us). **Plane 2 — user observability** (the operator
pipes their own instance's data into their own tools; nothing reaches us, so no consent applies).
The two planes share instrumentation but never share a pipe.

### Plane 1, Tier 1 — anonymous, opt-out, global

Genuinely anonymous aggregate signals collect by default: the **heartbeat (moving to daily)**, the
**marketplace install channel**, and future curated usage counters. Conditions that make this tier
defensible (GDPR-out-of-scope, not merely pseudonymous):

- **Anonymization bar**: no IP storage, no device fingerprint, no content, no paths; per-machine
  random `instanceId` only. Enforced by allowlist payloads + no-PII tests on send and receive
  (unchanged from 260711-141639), and payloads stay publicly documented at `/telemetry`.
- **Notice before first send** (Homebrew ordering): a first-run notice — printed in server/CLI logs
  and shown in the cockpit — appears before any Tier 1 payload leaves the machine.
- **Dead-simple off**: honor `DO_NOT_TRACK=1` (universal) and `DORKOS_TELEMETRY_DISABLED=1`
  (scoped); precedence env > config. Ship `dorkos telemetry status|enable|disable` and a
  `DORKOS_TELEMETRY_DEBUG=1` mode that prints the exact payload instead of sending it.
- **Consent-flip migration semantics**: an explicit prior "no" is never overridden; never-answered
  installs get the new default only after the notice is shown (tracked via a
  `telemetry.lastPromptedVersion` field reusing the `dismissedUpgradeVersions` re-prompt idiom).
- No regional branching in the app tier — like every peer tool, one global default, defended by
  real anonymization rather than geo-detection.

### Plane 1, Tier 2 — identified, opt-in

Anything tied to a person requires explicit opt-in: `identify()` with the **account UUID as a
pseudonymous distinct_id** (never email/name), merging prior anonymous history; error reporting
(today's Sentry path, double-gated); and later AI-run metadata. The device-link flow is the merge
point between site visitor, app instance, and account. **Account deletion must erase the PostHog
person** (extends the DOR-187 self-serve deletion). Consent surfaces: an onboarding step, a
"Privacy & Data" settings tab with live per-channel toggles, and the standalone banner as fallback.

### The site: hybrid cookieless + geo-gated consent

`posthog-js` runs `cookieless_mode: 'on_reject'` + `person_profiles: 'identified_only'`, so **100%
of visitors produce anonymous, cookieless, daily-salted-hash analytics** regardless of consent.
Region (Vercel geo header, middleware) picks the consent UX: **EU/EEA/UK/CH and unknown → opt-in
banner** (accept upgrades to cookie-based capture; unknown fails closed); **US and rest → no
banner, capture on by default** (the US opt-out regime), honoring DNT and `navigator.
globalPrivacyControl` (mandatory CA/TX) plus a working analytics-off control on `/privacy`. The
browser proxy path renames off PostHog's blocklist-matched `/ingest` default to a neutral path
(`/hub`); the apex domain remains the proxy (harder to block than any subdomain);
`hub.dorkos.ai` is reserved as the future split seam. This keeps the door open for ad pixels,
which will require the EU/UK banner regardless.

### One owned ingest, event-stream-first

A single generic endpoint (`/api/telemetry/events` beside the existing install/heartbeat routes)
accepts `{event, properties, distinctId}` validated against a **shared, Zod-typed event registry**
in `packages/shared` (`[object]_[verb]` snake_case; curated named events only, no autocapture in
the app). It fans out server-side: **Neon stays system-of-record** for marketplace ranking and
instance counts; PostHog receives everything for funnels/trends. The cockpit, desktop, and
Obsidian surfaces never embed a vendor SDK — app events flow through the server (Transport →
server → owned ingest), so all four clients ride one pipeline and the PostHog key lives only in
site env. Feedback becomes events: our own forms (cockpit + dorkos.ai) emit
`feedback_submitted`/`feature_requested`; the prefilled-GitHub-issue path stays as the developer
fallback; items needing action are promoted to Linear (the event stream detects, the tracker
actions — mirroring `/flow`). PostHog Surveys, if used, run headless (our UI, their events).

### Plane 2 — bring-your-own observability

The existing sanitized OTel layer gains an **OTLP exporter honoring standard `OTEL_*` env vars**
alongside the local `--debug-trace` file, so operators pipe traces into their own stack with zero
DorkOS-specific config. Agent runs emit `gen_ai.*` semantic-convention spans — serving the
operator's LLM observability directly, and (Tier 2, metadata-only: tokens/latency/model/cost,
never content) optionally bridged to our PostHog. The durable SSE streams are documented as a
supported integration surface. An optional Prometheus `/metrics` endpoint may follow; all Plane 2
surfaces are local/authenticated by default and never exposed through the public tunnel.

## Consequences

### Positive

- Real adoption signal at launch: ~100% anonymous site coverage, daily active instances, install
  funnels — instead of the consent-gated fraction.
- Principled and defensible: matches the Next.js/VS Code/Homebrew norm, honors DO_NOT_TRACK/GPC,
  keeps the "we never see your code" promise intact (content never leaves without explicit opt-in).
- One event stream: usage, feedback, errors, and AI metadata correlate in a single PostHog project
  under one identity spine (instanceId → account UUID).
- Vendor portability and a scrubbing control point: clients only ever talk to dorkos.ai; the
  PostHog key and any future vendor swap are server-side concerns.
- Plane 2 turns privacy posture into a feature: self-hosters get standards-based observability of
  their own instance for free.

### Negative

- "Private by default" softens to "anonymous by default" for Tier 1 — a real brand nuance that
  Priya-type users will scrutinize; the payload-preview mode and public payload docs are the
  mitigation, and all copy (/telemetry, /privacy, /cookies, /marketplace/privacy, onboarding,
  README) must move in lockstep.
- The opt-out legal position for Tier 1 rests on genuine anonymization; sloppiness (an IP logged at
  the edge, a stable hash treated as anonymous) collapses the argument. The no-PII tests are
  load-bearing.
- More moving parts: geo middleware, consent migration, event registry, and the ingest fan-out all
  need maintenance; a single vendor (PostHog) becomes the sink for most product signals.
- Identified-event costs (~4x anonymous) and event sprawl require curation discipline.

## Roadmap

| Phase | Scope                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Site hybrid: cookieless `on_reject`, geo middleware, GPC/DNT, `/ingest`→`/hub`, `person_profiles`, banner z-index fix, copy                             |
| 1     | Consent UX: DO_NOT_TRACK/env guards, `dorkos telemetry` trio + debug mode, first-run notice, Privacy & Data tab, onboarding step, `lastPromptedVersion` |
| 2     | Tier 1 flip: heartbeat daily + opt-out, install opt-out, migration, re-prompt, copy sweep                                                               |
| 3     | Generic ingest + shared event registry + cockpit product events (server-side)                                                                           |
| 4     | Accounts: opt-in identify, device-link merge, deletion erases PostHog person                                                                            |
| 5     | Feedback-as-events: cockpit + site forms, GitHub fallback, Linear promotion                                                                             |
| 6     | Errors: wire a DSN now; decide consolidation into owned ingest → PostHog `$exception` (open question below)                                             |
| 7     | AI observability: `gen_ai.*` spans, Tier 2 metadata-only bridge                                                                                         |
| P2    | (parallel) OTLP `OTEL_*` exporter, observability docs, SSE integration docs, optional `/metrics`                                                        |

## Open questions

- **Error consolidation**: replace the direct-to-Sentry path with owned-ingest → PostHog
  `$exception` (unifies the stream, removes the third-party egress), and whether scrubbed crash
  _signatures_ can then join Tier 1.
- **Ad pixels** (future): the moment one ships, the EU/UK banner must gate it and the CCPA/TDPSA
  "sharing" analysis changes — revisit this ADR's site section then.

## References

- Amends: [260711-141639](260711-141639-opt-in-observability-consent.md); related:
  [260711-153307](260711-153307-opt-in-error-reporting.md) (error scrubbing),
  ADR-0234/0235 (Neon marketplace telemetry).
- Research: `research/20260713_posthog_backend_ai_observability_headless_surveys.md`; legal +
  industry-practice findings summarized therein and in the 2026-07-13 strategy session.
- Prior art shipped: PR #265 (consent-gated site analytics — Phase 0 supersedes its
  banner-everywhere posture); DOR-21 (PostHog go-live), DOR-305 (funnels), DOR-306 (tracker
  comment-write bug).
