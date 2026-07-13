---
title: 'PostHog for Backend/CLI Telemetry, AI Observability, Headless Surveys, Error Tracking, and Identity (API-First, No PostHog UI Widgets)'
date: 2026-07-13
type: external-best-practices
status: active
tags:
  [
    posthog,
    posthog-node,
    ai-observability,
    llm-analytics,
    surveys,
    error-tracking,
    identify,
    reverse-proxy,
    headless,
  ]
searches_performed: 10
sources_count: 20
---

# PostHog for Backend/CLI Telemetry, AI Observability, Headless Surveys, Error Tracking, and Identity

## Research Summary

PostHog supports the "send data via API, render your own UI" model DorkOS wants across every surface asked about: `posthog-node` captures events, identifies users, and tracks exceptions from any Node process (server or CLI); AI Observability ($ai_generation/$ai_trace events) can be sent from a backend either via SDK wrapper or fully manual capture/raw HTTP, making it a natural fit for a system that orchestrates Claude Code, Codex, and OpenCode; Surveys has an explicit "API mode" designed for custom UIs, with three lifecycle events (`survey shown`, `survey sent`, `survey dismissed`) plus a REST Surveys API for managing/reading survey config server-side; Error Tracking accepts backend exceptions via `captureException()`; and PostHog project API keys are write-only and officially sanctioned as public/embeddable in CLIs and desktop apps, with the reverse-proxy pattern recommended primarily for ad-blocker evasion, not key secrecy.

---

## 1. Server-Side / Backend Capture (posthog-node in server + CLI)

**Bottom line:** Yes — `posthog-node` is PostHog's first-class server-side library, works in both long-running servers and short-lived CLI processes, batches automatically, and DorkOS should NOT worry about embedding the project key (it's write-only/public by design). A reverse proxy is recommended, but its purpose is ad-blocker evasion, not key confidentiality.

### Capture, identify, flush

```javascript
import { PostHog } from 'posthog-node';

const client = new PostHog('<ph_project_api_key>', {
  host: 'https://us.i.posthog.com',
});

client.capture({
  distinctId: 'user_or_device_id',
  event: 'cli_command_run',
  properties: { command: 'dorkos start', runtime: 'claude-code' },
});

client.identify({
  distinctId: 'user_id',
  properties: { plan: 'pro' },
});

// Always call before process exit
await client.shutdown();
```

- `distinctId` is required on every call and must match the identifier used elsewhere (frontend, CLI, backend) so events link into one person. Unlinked/orphaned backend events "can't be linked to frontend event captures, session replays, LLM traces, or error tracking." [Node.js - Docs - PostHog](https://posthog.com/docs/libraries/node)
- Event naming convention: `[object] [verb]`, e.g. `project created`, `cli command run`.

### Batching behavior

- Default: `flushAt: 20` (flush after 20 queued events) and `flushInterval: 10000` (flush every 10s) — good defaults for a **long-running server**.
- For a **short-lived CLI process**, defaults are dangerous: the process may exit before the interval/threshold triggers a flush, silently dropping events. PostHog's own serverless guidance applies directly: set `flushAt: 1` and `flushInterval: 0` (flush immediately, no batching) and always `await posthog.shutdown()` at the end of the process to guarantee delivery before exit. [Node.js - Docs - PostHog](https://posthog.com/docs/libraries/node)
- `client.shutdown()` is the full teardown (drains queue, resolves promises) — use once before process exit. `client.flush()` is for per-request cleanup in servers that stay alive (e.g., between HTTP requests), not full shutdown.
- There is also a synchronous `captureImmediate()` for cases where you need to guarantee an event lands before continuing (referenced in the Node SDK reference).

### CLI-specific recommendation

For DorkOS's CLI, the pattern should be: instantiate the client at process start with `flushAt: 1, flushInterval: 0`, capture events inline, and `await client.shutdown()` in the CLI's exit path (including on `SIGINT`/error handlers) so a `Ctrl+C` or crash doesn't lose the final telemetry batch.

### Project API keys are public by design — no need to hide them

- "The project API key is a **write-only key**... it can't read events or any of your other data stored with PostHog, so it's safe to use in public integrations" and safe to embed in frontend bundles, CLIs, or desktop apps. [Is it OK to expose the posthog project api key to the public? - PostHog](https://posthog.com/questions/is-it-ok-to-expose-the-posthog-project-api-key-to-the-public)
- Contrast: the **Personal API Key** (`phx_...`) grants admin/read access to your whole PostHog account and must never be embedded or shipped in any client.
- This directly answers the DorkOS concern: a distributed desktop/CLI app can safely ship the `phc_...` project key. It cannot be used to exfiltrate data — worst case with an exposed key is spam/junk events, which PostHog also has ingestion-side abuse protections for.

### Reverse proxy: what it's actually for

- PostHog's official reverse-proxy guidance frames it as an **ad-blocker workaround**, not a security measure: "Ad blockers maintain lists of known analytics domains and block requests to them. A reverse proxy bypasses this by routing events through your own domain, which ad blockers haven't cataloged." Typically increases event capture 10-30%. [Deploy a reverse proxy - Docs - PostHog](https://posthog.com/docs/advanced/proxy)
- Two options:
  - **Managed reverse proxy** (PostHog Cloud, free): PostHog auto-handles SSL/routing/maintenance via Cloudflare-backed infra. Not HIPAA-compliant.
  - **Self-hosted proxy**: Cloudflare Workers, AWS CloudFront, Next.js middleware, Kubernetes, nginx, etc. — full control, but you own troubleshooting and any bandwidth/invocation costs (e.g., on Vercel/Netlify).
- Setup (managed): create a proxy subdomain in org settings → add CNAME DNS record to PostHog's generated domain → wait for DNS/SSL propagation (2-30 min) → point `api_host` (and `ui_host` if using PostHog's own UI, irrelevant for DorkOS) at the subdomain.
- **For a Node/CLI backend that never runs in a browser, a reverse proxy is largely moot** — ad blockers only intercept browser network requests. It matters for the DorkOS **web client** (`apps/client`), not the server or CLI SDK.

---

## 2. AI Engineering / LLM Observability

**Bottom line:** PostHog's AI Observability (aka "LLM analytics" — same product, renamed) is directly applicable to a Claude Code/Codex/OpenCode orchestrator. It captures generations, traces, spans, tokens, cost, latency, and model as **plain PostHog events** (`$ai_generation`, `$ai_trace`, `$ai_span`, `$ai_embedding`), can be sent from a backend with zero PostHog UI involvement (manual capture or raw HTTP), and surfaces cost-per-user, per-model performance, and full trace drill-down in a purpose-built dashboard.

### What it captures

- **Generations** (`$ai_generation`): one event per LLM call, recording model, provider, input messages, output, `$ai_input_tokens`/`$ai_output_tokens`, latency, and cost. [Generations - Docs - PostHog](https://posthog.com/docs/ai-observability/generations) / [Getting started with AI Observability - Docs - PostHog](https://posthog.com/docs/ai-observability/start-here)
- **Traces** (`$ai_trace`): groups related generations/spans into one logical interaction (e.g., one agent run), via a shared `$ai_trace_id`. Required for all AI Observability events — every generation/span must carry a `$ai_trace_id`. [Traces - Docs - PostHog](https://posthog.com/docs/ai-observability/traces)
- **Spans** (`$ai_span`): sub-operations inside a trace (e.g., a tool call, a retrieval step) — useful for multi-step agent runs like Claude Code tool invocations.
- **Sessions**: can group multiple traces (e.g., one CLI session with multiple agent turns).
- **Embeddings** (`$ai_embedding`): tracked separately if DorkOS ever does vector search/RAG.
- Cost is auto-calculated from `$ai_provider` + `$ai_model` + token counts using OpenRouter pricing data as the source of truth; Anthropic/Claude models use "exclusive" token counting, other providers "inclusive." Custom pricing overrides are possible via `$ai_input_token_price` / `$ai_output_token_price` (both required together). [Calculating LLM costs - Docs - PostHog](https://posthog.com/docs/ai-observability/calculating-costs)

### How to send data — three options, all backend-capable

1. **SDK wrapper** (`@posthog/ai`, or wrapped OpenAI/Anthropic SDK clients) — wraps your existing provider SDK so calls still go straight to the provider, while the wrapper extracts metadata and ships it to PostHog automatically. Zero manual event construction. [Getting started with AI Observability - Docs - PostHog](https://posthog.com/docs/ai-observability/start-here)
2. **Manual capture via `posthog-node`** — construct `$ai_generation`/`$ai_trace` events yourself and call `client.capture()`, giving full control over properties (essential if DorkOS is not calling OpenAI/Anthropic SDKs directly, but is instead relaying output from Claude Code/Codex/OpenCode's own SDKs/CLIs). [Manual capture - Docs - PostHog](https://posthog.com/docs/ai-observability/installation/manual-capture)
3. **Raw HTTP capture** — POST directly to `https://<host>/i/v0/e/` with the event payload (project API key + `$ai_generation`/`$ai_trace` properties: `$ai_trace_id`, `$ai_session_id`, `$ai_model`, `$ai_provider`, `$ai_input`, `$ai_input_tokens`, `$ai_output_choices`, `$ai_output_tokens`, `$ai_latency`, `$ai_http_status`). This is the option with zero PostHog SDK dependency at all — pure API. [Capture and batch API endpoints - Docs - PostHog](https://posthog.com/docs/api/capture)

All three are equally "backend, no PostHog UI" — DorkOS can pick whichever fits its architecture (likely manual `posthog-node` capture, since DorkOS relays agent SDK output rather than calling LLM provider SDKs directly).

### Insights unlocked

- Purpose-built **LLM analytics dashboard**: Users, Traces, Costs sections out of the box, fully customizable with your own insights/text cards. Answers questions like "What are my LLM costs by customer?" and "Are there generation latency spikes?" [LLM analytics dashboard - Docs - PostHog](https://posthog.com/docs/llm-analytics/dashboard)
- Cost/latency/error-rate per user or session; drill from an aggregate metric down to "the exact conversation, the exact prompt, and the exact user cohort affected."
- Because these are plain PostHog events, they join the rest of product analytics — you can correlate LLM cost/errors with retention, conversion, or any custom DorkOS event (e.g., "sessions where agent X errored had Y% lower next-day return") without a separate observability tool.
- PostHog pitches this as ~10x cheaper than dedicated LLM-observability vendors since it rides the same event-ingestion pipeline. [AI Observability – Observe and optimize AI products in PostHog](https://posthog.com/ai-observability)

### Relevance to DorkOS

Directly applicable: each Claude Code/Codex/OpenCode turn maps naturally to an `$ai_generation` (or a `$ai_trace` with nested spans for multi-tool-call turns), with `$ai_provider` = "anthropic"/"openai"/etc, `$ai_model`, and DorkOS's own `distinctId`/groups (e.g., `posthog.group('runtime', 'claude-code', ...)` , `posthog.group('workspace', ...)`) layered on top. This gives DorkOS a built-in per-runtime cost/performance comparison view — cost per user, per project, per runtime — entirely via API, no PostHog widget required.

---

## 3. Surveys (Headless / API-Only)

**Bottom line:** Yes. PostHog Surveys has an explicit **"API mode"** built for exactly this: fetch survey config via the SDK/API, render your own UI, and capture three canonical lifecycle events (`survey shown`, `survey sent`, `survey dismissed`). There's also a REST Surveys API for server-side survey management. And yes, you can skip Surveys entirely and just send arbitrary `posthog.capture('feedback_submitted', {...})` events — PostHog doesn't require the Surveys product for that.

### API-mode / custom survey UI pattern

- "With the API approach, you can implement your own survey UI and use PostHog to handle display logic, capturing results, and analytics. When you create one in API mode, you need to add logic to fetch and display surveys yourself." [Implementing custom surveys - Docs - PostHog](https://posthog.com/docs/surveys/implementing-custom-surveys)
- Fetch active surveys matching the current user's targeting conditions: `posthog.getActiveMatchingSurveys((surveys) => { ... })` (JS SDK). This is the documented path — as of current docs, custom survey fetch/render is only wired up in the **JavaScript Web SDK** (`posthog-js`), not `posthog-node`. For a CLI, DorkOS would likely need to either (a) fetch survey config once via the REST API server-side and bake targeting logic itself, or (b) run this from the web cockpit client only.
- Survey data shape includes `id`, `name`, `description`, `questions[]` (with `id` UUIDs, type, choices), `appearance`, `targeting_flag_key`, `start_date`, `end_date`.

### Exact lifecycle event names/properties

- **`survey shown`** — fire when a user is shown a survey: `posthog.capture("survey shown", { $survey_id: survey.id })`
- **`survey sent`** — the primary results event, fired with the answers:
  ```javascript
  const responses = survey.questions.map((q) => ({
    [`$survey_response_${q.id}`]: userAnswer,
  }));
  posthog.capture('survey sent', { $survey_id: survey.id, ...responses });
  ```
  Property key is `$survey_response_{questionId}` (ID-based, current/preferred format); legacy `$survey_response`/`$survey_response_1` (index-based) is deprecated.
- **`survey dismissed`** — fire when a user closes/skips without responding: `posthog.capture("survey dismissed", { $survey_id: survey.id })`

Source: [Implementing custom surveys - Docs - PostHog](https://posthog.com/docs/surveys/implementing-custom-surveys), [Survey API Reference - PostHog](https://posthog.com/docs/api/surveys)

### REST Surveys API (server-side survey management)

- `GET /api/projects/:project_id/surveys/` — list surveys
- `GET /api/projects/:project_id/surveys/:id/` — fetch one survey's config
- `GET /api/projects/:project_id/surveys/:id/responses/` — retrieve response data
- `GET /api/projects/:project_id/surveys/:id/stats/` — aggregate stats
- Auth: Bearer token, Personal API Key with `survey:read`/`survey:write` scopes.
- This lets DorkOS's server pull survey definitions, decide which survey to show a given CLI/app user (its own targeting logic), and separately push results back as `survey sent` events via `posthog-node` — a fully headless loop with zero PostHog-rendered UI. [Survey API Reference - PostHog](https://posthog.com/docs/api/surveys)

### Skipping Surveys entirely: plain custom events

You do not need the Surveys product at all to collect feedback. Any arbitrary event works the same as any other PostHog event and is fully queryable/dashboardable:

```javascript
client.capture({
  distinctId: userId,
  event: 'feedback_submitted',
  properties: {
    feedback_text: '...',
    category: 'bug',
    rating: 4,
    runtime: 'claude-code',
  },
});
```

This is arguably the simpler path for DorkOS given it's already building custom UI — Surveys' main value-add (over a plain custom event) is targeting-rule management (who sees what survey, response-rate limiting, dismiss/repeat logic) and native analytics tie-in (session-recording-linked responses, built-in survey completion funnels). If DorkOS doesn't need PostHog's targeting engine, a plain `feedback_submitted`/`feature_requested` custom event is fully sufficient and simpler to operate.

---

## 4. Support / Feedback / Messaging

**Bottom line:** PostHog is not a support-inbox or messaging product (no Intercom/Zendesk-style ticketing or chat). Its "feedback" surface is Surveys (+ optional pre-built feedback widget, which DorkOS would skip since it wants its own UI) plus the AI Observability "collect user feedback" pattern for thumbs up/down on LLM traces. Any feedback captured as an event — whether via Surveys or a plain custom event — becomes a first-class PostHog event and is immediately usable in Insights, dashboards, and cohorts.

- **Feedback widgets**: PostHog ships pre-built "feedback widget" survey types (a pinned tab UI) — DorkOS doesn't want this (it's PostHog-rendered), but it confirms the underlying event model is the same Surveys `survey shown`/`sent`/`dismissed` triplet, so a custom-rendered feedback button funneling into the same events gets identical backend analytics. [Surveys – Collect product feedback with PostHog](https://posthog.com/surveys)
- **AI-specific feedback**: PostHog supports attaching thumbs up/down (or free-text) feedback directly to a given LLM trace via Surveys integration, letting you correlate "bad" AI responses with the exact trace/generation that produced them. [Collecting user feedback - Docs - PostHog](https://posthog.com/docs/ai-observability/collect-user-feedback) — directly relevant if DorkOS wants "was this agent turn helpful?" feedback tied to a specific Claude Code/Codex run.
- **Turning feedback into dashboards**: because feedback (survey-sourced or custom-event-sourced) is stored as a normal event with normal properties, it's queryable in PostHog's SQL-backed Insights/HogQL just like any other event — trend charts of `feedback_submitted` by `category`, funnels from `agent_error` → `feedback_submitted`, etc. No separate reporting layer needed.
- **No native support inbox/ticketing/live chat**: PostHog does not offer a Zendesk/Intercom-style conversation thread or agent-facing support queue. If DorkOS wants two-way messaging with users, that's outside PostHog's scope — PostHog's roles here start and end at capturing the feedback event and letting DorkOS build (or bolt on a separate tool for) the reply workflow.

---

## 5. Error Tracking (Browser + Node/Backend)

**Bottom line:** Error Tracking works from both `posthog-js` (browser) and `posthog-node` (server/CLI) via `captureException()`. Backend/CLI processes are fully supported — the only nuance is that autocapture-of-uncaught-exceptions is a browser/Express-hooked feature; a bare CLI should call `captureException()` explicitly (e.g., in its top-level try/catch or `process.on('uncaughtException', ...)`), and must flush before exit or the exception event can be lost.

### Browser

- Automatic: enabling exception autocapture hooks `window.onerror` and `window.onunhandledrejection`.
- Manual: `posthog.captureException(error, { custom_property: 'value' })`.
- Rule: "Never manually capture `$exception` events using `posthog.capture('$exception', {...})`" — always go through `captureException()`, which handles stack-trace processing and source-map integration correctly. [Capture exceptions for error tracking - Docs - PostHog](https://posthog.com/docs/error-tracking/capture)

### Node / backend

- `posthog.captureException(error, distinctId, { custom_property: 'value' })` — same method family, Node signature takes an explicit `distinctId` as the second argument.
- Optional `enableExceptionAutocapture` at client init auto-captures uncaught exceptions/unhandled rejections in a Node process. **Caveat for Express**: Express swallows uncaught exceptions internally, so autocapture won't fire there unless you also call `setupExpressErrorHandler(client, app)` — directly relevant to DorkOS's Express 5 server (`apps/server`). [Node.js error tracking installation - Docs - PostHog](https://posthog.com/docs/error-tracking/installation/node)
- Known gotcha (open issue as of these docs): a `captureException()` call immediately followed by process exit / `shutdown()`/`flush()` can fail to actually flush the exception event before the process dies — i.e., `enableExceptionAutocapture` is unreliable for exceptions that terminate the process. For a CLI (which often crashes and exits immediately after an uncaught error), DorkOS should explicitly `await client.captureException(...)` then `await client.shutdown()` in its top-level error handler rather than relying on autocapture. [`captureException` doesn't get flushed... · Issue #2220](https://github.com/PostHog/posthog-js/issues/2220) — note this issue is filed against `posthog-js` but the flush-ordering pattern is worth defensively coding around in `posthog-node` too, given `flushAt`/`flushInterval` batching defaults.

### CLI/server sending exceptions — confirmed viable

Yes: any Node process (long-running server or short-lived CLI) can call `client.captureException()`. For a CLI specifically, apply the same "serverless" flush discipline as regular events — `flushAt: 1, flushInterval: 0`, and an explicit `await client.shutdown()` in the exit path — to avoid losing the exception in the same window the process is dying in.

### Issue grouping

- PostHog auto-generates an `$exception_fingerprint` to group related exceptions into one "Issue," using stack trace/error-type heuristics.
- This is overridable at capture time for custom grouping: `posthog.captureException(error, { "$exception_fingerprint": "CustomExceptionGroup" })` — useful for DorkOS to group, e.g., all "agent runtime crashed: claude-code" errors together regardless of stack trace differences across SDK versions. [Capture exceptions for error tracking - Docs - PostHog](https://posthog.com/docs/error-tracking/capture)

---

## 6. Anonymous vs. Identified + Cost

**Bottom line:** `person_profiles: 'identified_only'` (the current recommended default) means anonymous/pre-login events are captured cheaply without creating a full person profile; calling `identify(distinctId, props)` after account creation both creates/updates that person's profile and retroactively merges their prior anonymous event history into the new identified person. Identified events are more expensive to process than anonymous ones (up to 4x) because of person-profile resolution/merge overhead — so DorkOS should default to anonymous capture pre-auth and only "spend" identification on users who actually create a DorkOS account.

- **`person_profiles: 'identified_only'`** (config on init): anonymous events are captured by default without a person profile; PostHog only creates/updates a person profile once `identify()` (or `group()`/`alias()`, etc.) has been called for that distinct ID. This is the currently recommended setting to control cost. [Anonymous vs identified events - Docs - PostHog](https://posthog.com/docs/data/anonymous-vs-identified-events)
- **Cost**: "Anonymous events can be up to 4x cheaper to process than identified events, because identifying a user involves resolving and updating person profiles." Direct incentive to stay anonymous until there's a real account to attach to. [Anonymous vs identified events - Docs - PostHog](https://posthog.com/docs/data/anonymous-vs-identified-events)
- **Identify + merge flow**: `posthog.identify(distinctId, { $set: {...}, $set_once: {...} })` called right after account creation/login — PostHog "creates a person profile and links it to both the identified distinct ID and any previous anonymous events from that session," merging the pre-login anonymous history into the new identified person. [Identifying users - Docs - PostHog](https://posthog.com/docs/product-analytics/identify) / [People - Docs - PostHog](https://posthog.com/docs/data/persons)
- **`$set` vs `$set_once`**: `$set` overwrites a person property every call (mutable state like plan/email); `$set_once` only writes if the property doesn't already exist (first-touch data like signup source).
- **`alias()`** for cross-surface stitching: when the same person has a frontend distinct ID and a different backend-only identifier (e.g., a CLI device ID vs. a web session ID that only becomes known after account link), `alias()` merges both into one person going forward — the documented fix for "duplicate profiles" caused by inconsistent distinct IDs across systems (a real risk for DorkOS given it has CLI, desktop, web, and Obsidian surfaces potentially generating distinct IDs independently before a user logs in anywhere). [Identity resolution - Docs - PostHog](https://posthog.com/docs/product-analytics/identity-resolution)
- **Privacy implication**: staying anonymous (no `identify()` call) means PostHog stores events under a device/session-scoped distinct ID with no PII attached unless you explicitly `$set` PII properties — a reasonable default for DorkOS's non-account-holding CLI users (e.g., someone running the OSS CLI without ever creating a DorkOS account). Only call `identify()` once the user has actually created a DorkOS account (their choice to be tracked-as-a-person), keeping pre-account telemetry anonymous and cheap, and post-account telemetry identified and richer (cross-device, cross-session person view) — which matches PostHog's own recommended pattern.

---

## Sources & Evidence

- [Node.js - Docs - PostHog](https://posthog.com/docs/libraries/node) — posthog-node capture/identify/batching/flush/serverless config
- [PostHog Node.js SDK reference](https://posthog.com/docs/references/posthog-node) — API surface incl. `captureImmediate`
- [Capture and batch API endpoints - Docs - PostHog](https://posthog.com/docs/api/capture) — raw HTTP `/i/v0/e/` capture endpoint
- [Deploy a reverse proxy - Docs - PostHog](https://posthog.com/docs/advanced/proxy) — managed vs self-hosted proxy, ad-blocker rationale, setup steps
- [Is it OK to expose the posthog project api key to the public? - PostHog](https://posthog.com/questions/is-it-ok-to-expose-the-posthog-project-api-key-to-the-public) — project key is write-only/public-safe; personal key is not
- [Getting started with AI Observability - Docs - PostHog](https://posthog.com/docs/ai-observability/start-here)
- [AI Observability basics - Docs - PostHog](https://posthog.com/docs/ai-observability/basics)
- [Generations - Docs - PostHog](https://posthog.com/docs/ai-observability/generations) / [Traces - Docs - PostHog](https://posthog.com/docs/ai-observability/traces)
- [Manual capture - Docs - PostHog](https://posthog.com/docs/ai-observability/installation/manual-capture) — manual `$ai_generation`/`$ai_trace` capture, curl example
- [Calculating LLM costs - Docs - PostHog](https://posthog.com/docs/ai-observability/calculating-costs)
- [LLM analytics dashboard - Docs - PostHog](https://posthog.com/docs/llm-analytics/dashboard)
- [AI Observability – Observe and optimize AI products in PostHog](https://posthog.com/ai-observability)
- [Implementing custom surveys - Docs - PostHog](https://posthog.com/docs/surveys/implementing-custom-surveys) — API mode, `survey shown`/`sent`/`dismissed`
- [Survey API Reference - PostHog](https://posthog.com/docs/api/surveys) — REST endpoints for survey management
- [Surveys – Collect product feedback with PostHog](https://posthog.com/surveys) — feedback widgets, product overview
- [Collecting user feedback - Docs - PostHog](https://posthog.com/docs/ai-observability/collect-user-feedback) — thumbs up/down tied to LLM traces
- [Capture exceptions for error tracking - Docs - PostHog](https://posthog.com/docs/error-tracking/capture) — `captureException`, fingerprinting/grouping
- [Node.js error tracking installation - Docs - PostHog](https://posthog.com/docs/error-tracking/installation/node) — Node/Express caveats, `enableExceptionAutocapture`
- [`captureException` doesn't get flushed... · Issue #2220 - PostHog/posthog-js](https://github.com/PostHog/posthog-js/issues/2220) — flush-before-exit gotcha
- [Anonymous vs identified events - Docs - PostHog](https://posthog.com/docs/data/anonymous-vs-identified-events) — `person_profiles: identified_only`, 4x cost differential
- [Identifying users - Docs - PostHog](https://posthog.com/docs/product-analytics/identify) — `identify()`, `$set`/`$set_once`, anonymous-history merge
- [People - Docs - PostHog](https://posthog.com/docs/data/persons)
- [Identity resolution - Docs - PostHog](https://posthog.com/docs/product-analytics/identity-resolution) — `alias()` for cross-surface stitching

## Research Gaps & Limitations

- The Surveys REST API's ability to accept response _submissions_ (write) directly, versus only reading response data collected via SDK-captured events, was not independently verified beyond search-summary level — DorkOS should confirm at implementation time whether `survey sent` events must go through `posthog.capture()` (client or `posthog-node`) or whether the REST API also accepts direct response writes.
- `getActiveMatchingSurveys()` and the documented custom-survey fetch pattern are confirmed only for `posthog-js` (browser/web client); no explicit `posthog-node` equivalent was found. For a CLI to run its own survey targeting logic without a browser, DorkOS likely needs to pull survey config via the REST Surveys API and implement targeting itself, then log results via `posthog-node` capture — this composition works but isn't a named "posthog-node surveys" feature.
- Exact current `@posthog/ai` SDK wrapper API (for OpenAI/Anthropic client wrapping) was not pulled in full detail — DorkOS should fetch `posthog.com/docs/ai-engineering` or the `@posthog/ai` package docs directly if choosing the wrapper path over manual capture.
- Pricing/plan gating (which of these features are free vs. paid-tier-only, e.g., Error Tracking or AI Observability event volume limits) was out of scope for this research pass.

## Search Methodology

- Searches performed: 10 WebSearch + 8 WebFetch
- Most productive search terms: "posthog-node capture identify flush", "PostHog AI engineering LLM observability $ai_generation $ai_trace", "PostHog surveys API headless custom UI", "PostHog error tracking captureException Node", "PostHog person_profiles identified_only anonymous cost"
- Primary information sources: posthog.com/docs (official documentation across Node SDK, AI Observability, Surveys, Error Tracking, Data/Identity sections), posthog.com/questions community Q&A, GitHub PostHog/posthog-js issue tracker
