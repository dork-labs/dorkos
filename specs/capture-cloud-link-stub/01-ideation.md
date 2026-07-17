---
slug: capture-cloud-link-stub
id: 260717-191228
created: 2026-07-17
status: ideation
linearIssue: DOR-301
---

# Capture: test-mode auth/cloud-link seam for the Accounts pending→linked shot

**Slug:** capture-cloud-link-stub
**Author:** Daguerre (IDEATE stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-301 · type idea→design · size 3 · Low · split from DOR-283 (docs media)

---

## 1) Intent & Assumptions

- **Task brief (verbatim from DOR-301):** "the Accounts Settings pending→linked
  flip is real + implemented (specs/accounts-and-auth + cloud-account-management
  are implemented), but can't be captured in the isolated offline capture stack:
  `CloudLinkManager.startLink()` hits the real dorkos.ai cloud
  (`resolveCloudBaseUrl` + `requestDeviceCode`, services/core/auth/cloud-link.ts
  :150-166) and the pending→linked transition needs a human clicking Approve on
  the live site. `CloudLinkManager` already supports injectable
  `fetchImpl`/`CloudConfigPort` (`CloudLinkManagerOptions`, cloud-link.ts:102-109).
  A `DORKOS_TEST_RUNTIME`-gated stub (fake device code + auto-flip to linked
  after a short delay) is honest: it fakes the NETWORK dependency exactly like
  demo-scenarios.ts fakes the agent backend — not a feature that doesn't work.
  Real server engineering in services/core/auth/ → deserves a design note +
  review, then a capture drive + docs embed in
  docs/self-hosting/dorkos-accounts.mdx. Out of scope (documented on DOR-283):
  the /account/instances table in apps/site."

- **The intent is exactly right and should survive.** The Settings → DorkOS
  account panel really flips pending → linked in place (verified end to end in
  `specs/accounts-and-auth` + `specs/cloud-account-management`); the docs page
  already narrates it ("Approve, and watch it flip"). The only thing missing is
  a truthful way to photograph it inside the offline capture stack, which by
  design has no real Claude/Codex/OpenCode creds and must never touch the
  operator's real cloud. This is a **capture-enablement seam**, not a new
  product feature.

- **The line-number pointers in the brief are stale but the seams are real.**
  The real code today: `startLink()` is at `cloud-link.ts:179`, and it calls
  `resolveCloudBaseUrl()` + `requestDeviceCode({ …, fetchImpl: this.fetchImpl })`
  at lines 181-187. `CloudLinkManagerOptions` (the injectable `fetchImpl` /
  `CloudConfigPort` / `sleep` / `now`) is at lines 122-135. Everything the brief
  relies on exists; the numbers just drifted.

- **One structural fact reframes the "just inject the seam" framing** (detail in
  §3): the seams (`fetchImpl`, `config`) are constructor options, but the
  process-wide manager is an **eagerly-constructed module singleton**
  (`export const cloudLinkManager = new CloudLinkManager()`, cloud-link.ts:369)
  that both `routes/cloud.ts` and `index.ts` import **directly**. So there is no
  composition point that can inject the fake today. The honest fix — mirroring
  how `index.ts` swaps in `TestModeRuntime` under `DORKOS_TEST_RUNTIME` — is a
  small, reviewable **construction seam** so the composition root owns the
  manager's construction. That is the "real server engineering that deserves a
  design note + review."

- **The honesty model (the whole reason this is allowed).** `demo-scenarios.ts`
  fakes the **agent backend**: scripted stream events flow through the exact
  normalizer → projector → SSE path a production runtime uses, so the client
  renders real components against real (seeded) data. The cloud-link stub fakes
  exactly **one** thing — the `FetchLike` HTTP transport to dorkos.ai — and lets
  the real state machine, real token persistence, real poll loop, real
  heartbeat, and the real client UI run against its canned responses. It fakes
  the network dependency and nothing else. Same category as demo-scenarios: not
  a feature that doesn't work, a network we can't reach offline.

- **Assumptions:**
  - The capture stack is offline and isolated (`apps/e2e/capture/boot.ts`:
    isolated `DORK_HOME=~/.dork-capture`, pinned `DORKOS_BOUNDARY`, no real
    creds). The stub must keep it that way: **zero** real calls to dorkos.ai.
    `boot.ts` does not set `DORKOS_CLOUD_URL`, so `resolveCloudBaseUrl()` returns
    the real `https://dorkos.ai` — which is precisely why a real fetch would
    escape the sandbox and why the fake must intercept the transport (not point
    at a staging URL).
  - `DORKOS_TEST_RUNTIME=true` is already set for every capture boot
    (`boot.ts:42`) and for e2e; it is the same gate that mounts test-control
    routes (`app.ts:142`), registers `TestModeRuntime` (`index.ts:441`), and
    exposes the demo scenarios. It is the correct and only gate for the stub.
  - Cloud accounts are a shipped, verified surface (not behind the demo-claim
    gate the way Mesh+Relay / Windows / Obsidian are), so a truthful shot of the
    pending→linked flip **is** allowed to be marketed/documented. The stub does
    not change that; it only lets us photograph what already works.
  - The Settings dialog opens to the account tab by URL deep-link
    (`?settings=account`, `dialog-search-schema.ts` + `useSettingsDeepLink`),
    which the Playwright harness can navigate to directly.

- **Out of scope:**
  - The **/account/instances registry table in `apps/site`** — explicitly
    documented out on DOR-283. That is a Next.js site surface, not the isolated
    cockpit capture; it is not photographed by this pipeline.
  - Any change to the **production** device-flow, token persistence, heartbeat,
    routes, or client. The stub adds a test-only transport and a construction
    seam; it does not touch the RFC 8628 logic.
  - Faking the **cloud's** device endpoints as a real HTTP server. We fake the
    `FetchLike` in-process (like demo-scenarios fakes the stream), not a network
    listener.
  - Standing up a real linked account against staging. That would be a live
    dependency and non-deterministic — the opposite of the offline capture
    contract.

## 2) Pre-reading Log

- `AGENTS.md` / `.claude/rules/user-facing-writing.md`: control panel not
  consumer app; the **demo-claim gate** (never stage a shot implying an
  unverified surface works). Cloud accounts are verified, so this shot is clear.
- `.agents/skills/capturing-product-media/SKILL.md`: the shot registry
  (`apps/e2e/capture/shots.ts`) is the single source of truth; **real UI +
  seeded data only**, skip-and-report over faking; the **test-mode seam** is
  named explicitly ("Demo scenarios … reachable only when
  `DORKOS_TEST_RUNTIME=true`"). This is the exact pattern the stub extends. Also:
  "Add a docs-only shot by listing it with the right consumers." Deterministic,
  pinned content (never `Date.now()`).
- `apps/server/src/services/core/auth/cloud-link.ts`: the `CloudLinkManager`
  state machine. `startLink()` (179) → `resolveCloudBaseUrl()` +
  `requestDeviceCode({fetchImpl})` → `setState('pending')` → background
  `runPoll` → on `approved`, `config.save({instanceToken})` + `setState('linked')`
  - heartbeat. **Options** (`CloudLinkManagerOptions`, 122-135): `fetchImpl`,
    `sleep`, `now`, `config` (`CloudConfigPort`), `heartbeatIntervalMs`,
    `resolveTelemetryInstanceId`. **Singleton** at 369 (`export const
cloudLinkManager = new CloudLinkManager()`) — the composition problem.
- `apps/server/src/services/core/auth/cloud-link-client.ts`: the **pure** device
  flow — exactly the surface a fake `FetchLike` must satisfy. Endpoints:
  `POST {base}/api/auth/device/code` → `DeviceCodeResponse` (`device_code`,
  `user_code`, `verification_uri`, `expires_in`, `interval`);
  `POST {base}/api/auth/device/token` → `{access_token}` on success or a 400
  `{error}` in `{authorization_pending | slow_down | access_denied |
expired_token | invalid_grant}`; `POST {base}/api/instances/heartbeat`
  (Bearer) → `{instanceId, lastSeenAt, accountLabel}` (401 = unlinked);
  `POST {base}/api/instances/revoke`. A fake need only script these four.
- `apps/server/src/routes/cloud.ts`: thin over `cloudLinkManager` (imports the
  singleton directly). `POST /link/start`, `GET /link/status`, `POST /unlink`,
  `GET /status`. No injection point here — it imports the constructed instance.
- `apps/server/src/index.ts`: imports the singleton (26), calls
  `cloudLinkManager.initOnStartup()` at boot (1430) and `.stop()` on shutdown
  (1479). The `if (env.DORKOS_TEST_RUNTIME) { … register TestModeRuntime … }`
  block (441-456) is the **precedent** for composition-root, env-gated
  substitution via dynamic `import()`.
- `apps/server/src/services/runtimes/test-mode/demo-scenarios.ts`: the honesty
  template. Fakes the agent backend inside the test-mode boundary; reachable
  only under `DORKOS_TEST_RUNTIME`; merged into the scenario registry at import;
  paced in single-digit seconds for capture. The stub is its cloud-network
  sibling.
- `apps/server/src/routes/test-control.ts`: "This router is only mounted when
  `DORKOS_TEST_RUNTIME=true`." The unreachability pattern to copy for the stub.
- `apps/client/src/layers/features/cloud-link/ui/CloudLinkPanel.tsx`: the
  surfaces to photograph. `PendingState` renders the big mono `userCode`, an
  "Open dorkos.ai/activate" button, and "Waiting for you to approve on
  dorkos.ai…". `LinkedState` renders a green dot, "Linked", the `accountLabel`,
  and "Last synced …". These are the pending and linked money states.
- `apps/client/src/layers/features/cloud-link/model/use-cloud-link.ts`: the
  client polls `GET /api/cloud/link/status` every **2500ms** (`POLL_INTERVAL_MS`)
  while pending, stopping on terminal states. So the auto-flip must give the
  harness time to grab the pending still, then flip within a couple of client
  poll ticks for the linked still.
- `docs/self-hosting/dorkos-accounts.mdx`: the embed target. "Linking from
  Settings" has two `<Step>`s — "Link this instance" (pending, code visible) and
  "Approve, and watch it flip" (linked) — the natural homes for the two shots.
- `apps/e2e/capture/boot.ts` (`baseEnv`): sets `DORKOS_TEST_RUNTIME`,
  `DORK_HOME`, `DORKOS_BOUNDARY`, `DORKOS_RELAY_ENABLED`, `DORKOS_TASKS_ENABLED`
  — **no** `DORKOS_CLOUD_URL`. Confirms the stub must intercept the transport,
  not redirect a base URL.
- `apps/e2e/capture/shots.ts`: registry shape (`id`, `kind`, `frame`,
  `consumers`, optional `skipAuto`). No existing settings/account/cloud shot —
  this is net-new. Docs-only shots are common (`marketplace-detail`,
  `workbench`, `marketplace-installed`).
- `apps/e2e/capture/surfaces-desktop.ts`: the drive pattern —
  `shoot*(page, theme, rec)` navigates by URL, waits a money-state selector,
  calls `shoot(...)`; `captureLightStills` runs the light-still batch. A cloud
  drive slots in the same way (navigate `?settings=account`, click Link, wait
  pending, shoot; wait linked, shoot).
- `specs/accounts-and-auth` + `specs/cloud-account-management`: the linked/
  unlinked lifecycle, the `cloud.instanceToken` sensitive-field persistence, and
  the device-flow are already specified and implemented. This ideation adds
  nothing to that behavior — only a capture seam over it.

## 3) Codebase Map

- **Primary components / modules:**
  - `services/core/auth/cloud-link.ts` — the state machine + the singleton to
    reseat behind a construction seam.
  - `services/core/auth/cloud-link-client.ts` — the **exact `FetchLike`
    contract** the fake must satisfy (4 endpoints). Not modified.
  - **[NEW]** `services/runtimes/test-mode/<fake-cloud-link>.ts` — the fake
    `FetchLike` factory, inside the test-mode boundary next to
    `demo-scenarios.ts`.
  - `index.ts` — composition root; wires the fake under the existing
    `DORKOS_TEST_RUNTIME` branch (dynamic import, like `TestModeRuntime`).
  - `routes/cloud.ts` — consumes the manager via the seam (unchanged behavior).
  - `apps/e2e/capture/{shots.ts, surfaces-desktop.ts, config.ts}` — register
    2 shots, add the drive, pin the deterministic `user_code`/account label.
  - `docs/self-hosting/dorkos-accounts.mdx` — the two `<ProductShot>` embeds.
  - `apps/client/src/layers/features/cloud-link/ui/CloudLinkPanel.tsx` — the
    money-state selectors to wait on (not modified).

- **Data flow (production, unchanged):** client `start()` → `POST
/api/cloud/link/start` → `cloudLinkManager.startLink()` → **real fetch** →
  dorkos.ai device endpoints → pending → background poll → `approved` → token
  saved → linked → heartbeat.

- **Data flow (under the stub):** identical, except the manager's `fetchImpl`
  is the **fake** — `startLink()`'s `requestDeviceCode` and the poll's
  `pollForToken`/heartbeat all call the fake, which returns canned device code,
  then `authorization_pending` for a short window, then `{access_token}`, then a
  heartbeat `{accountLabel}`. Every other line runs for real. **No packet leaves
  the process.**

- **The composition seam (the crux):**

  | Today                                                     | Needed                                                                                               |
  | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
  | `export const cloudLinkManager = new CloudLinkManager()`  | Composition root constructs it (real defaults in prod; fake `fetchImpl` under `DORKOS_TEST_RUNTIME`) |
  | `routes/cloud.ts` + `index.ts` import the singleton value | They resolve it through a small accessor/holder so the root can inject before first request          |

  The eager singleton is the only thing standing between "the seam exists" and
  "the seam is injectable." Reseating construction to the composition root
  (behavior-preserving when no options are passed — real `globalThis.fetch`) is
  the reviewable server change.

- **Shared dependencies:** `env.DORKOS_TEST_RUNTIME` (`apps/server/src/env.ts`),
  `configManager` (the real token write-through still runs — the fake gives us a
  real token to persist into the isolated capture `config.json`), `logger`.

- **Feature flags / config:** no new config field. `DORKOS_TEST_RUNTIME` is the
  gate; it is already on in capture and e2e and off in every production path.

- **Potential blast radius:** the `cloudLinkManager` construction/import seam
  (touched by `routes/cloud.ts` + `index.ts`), plus additive files in test-mode,
  capture, and docs. Nothing in the production device-flow logic changes. The
  fake is never in the production module graph (dynamic import under the gate),
  so a shipped binary cannot reach it.

## 4) Research

**What the fake must script (the `FetchLike` contract).** From
`cloud-link-client.ts`, the fake intercepts by pathname and ignores the base URL:

1. `POST …/api/auth/device/code` → a `DeviceCodeResponse` with a **pinned**
   `user_code` (deterministic, so the pending still never churns — art-direction
   rule), `verification_uri: "https://dorkos.ai/activate"`, a short `interval`
   (e.g. 1s, mirroring demo pacing), and an `expires_in` long enough that the
   code never visibly expires mid-capture.
2. `POST …/api/auth/device/token` → `400 {error:"authorization_pending"}` for a
   short scripted window, then `200 {access_token:"<fake>"}`. This is the
   **auto-flip** — no human Approve needed. The window is what makes the flip
   land on camera.
3. `POST …/api/instances/heartbeat` → `200 {instanceId, lastSeenAt: <now>,
accountLabel: "<seeded label>"}` so the linked view shows the account and
   "Last synced just now". (A `lastSeenAt` of ~now renders as "just now" —
   stable enough; no pinned wall-clock needed.)
4. `POST …/api/instances/revoke` → `200` (best-effort; only exercised if a shot
   drives unlink — not required for the pending→linked shot).

Because `startLink()` already threads `this.fetchImpl` into `requestDeviceCode`
and the poll, injecting the fake at construction is the **entire** wiring on the
server side — no branching inside `cloud-link.ts`.

**Where the fake lives + how it's gated (the honesty line).** Options:

1. **Composition-root injection, fake in the test-mode boundary (recommended).**
   The fake `FetchLike` factory lives at
   `services/runtimes/test-mode/<fake-cloud-link>.ts` (next to
   `demo-scenarios.ts`). `index.ts`, inside its existing
   `if (env.DORKOS_TEST_RUNTIME)` block, `await import()`s the factory and
   constructs the manager with `{ fetchImpl: createFakeCloudLinkFetch() }`; the
   production branch constructs it with no options (real fetch). Requires the
   small construction seam so routes/index resolve the manager through the root.
   **Pros:** exact mirror of `TestModeRuntime` wiring; production `cloud-link.ts`
   has **zero** test branches and never imports the fake; the fake is not in the
   production module graph at all (dynamic import). **Cons:** the reseat-the-
   singleton refactor (small, reviewable).
2. **Env-branch the default `fetchImpl` inside `cloud-link.ts`.** Have the
   manager's default transport check `env.DORKOS_TEST_RUNTIME` and swap in the
   fake. **Reject:** this puts an `if (test)` branch and a test-mode import into
   a **production** auth module — exactly the "scattered if-tests in production
   code" the brief forbids, and it drags the fake into the production build.
3. **A real fake HTTP server on `DORKOS_CLOUD_URL`.** Stand up a listener in
   capture and point the base URL at it. **Reject:** heavier, adds a real socket
   and a port to the sandbox, and diverges from the in-process demo-scenarios
   pattern for no gain — we already own the `fetchImpl` seam.

   **Recommendation: Option 1.** It is the honest, pattern-consistent choice and
   the one the brief points at ("a test-only … `fetchImpl` at the composition
   edge, mirroring how demo-scenarios wires the fake backend").

**Unreachability — how we _assert_ the honesty line.** The stub must be
unreachable outside `DORKOS_TEST_RUNTIME`. Three defenses, layered:

- **Structural:** the fake is imported **only** by the composition root's
  `if (env.DORKOS_TEST_RUNTIME)` branch, via dynamic `import()` — so it is not
  in the production graph (same as `TestModeRuntime`).
- **Runtime guard:** the factory throws if constructed when
  `env.DORKOS_TEST_RUNTIME !== 'true'` (belt-and-suspenders, mirroring how
  test-control routes are only mounted under the gate).
- **Test:** a unit/guard test asserting (a) with the gate **off**, the composed
  `cloudLinkManager` uses the real `globalThis.fetch` (no injected fake); and
  (b) production `cloud-link.ts` / `cloud-link-client.ts` never import the
  test-mode fake (a simple import-graph/grep assertion). This is the proof, not
  a claim.

**Seam-isolation proof (production auth paths untouched).**

- The fake substitutes **only** `FetchLike`. The `CloudLinkManager` state
  machine, the `cloud.instanceToken` sensitive-field persistence, the poll/
  heartbeat/expiry logic, all four `/api/cloud/*` routes, and the entire client
  panel + poll run **unchanged** against the fake's canned responses. That is the
  definition of "fakes the network dependency, nothing else."
- Production `cloud-link.ts` changes only in **how the singleton is
  constructed** (reseated to the root), which is behavior-preserving with no
  options (real defaults). `cloud-link-client.ts` is not touched.
- The fake never runs in production (gate + dynamic import + throwing guard), so
  there is no path by which a shipped instance links against a fake cloud.
- In the capture stack the base URL is still `https://dorkos.ai`, but **no
  request reaches it** — the fake intercepts before any socket opens. That is the
  offline guarantee `capturing-product-media` requires.

**The capture flow (which shots, driven how, where they embed).**

- **The money moment** is the in-place pending → linked flip the docs narrate.
  The cleanest, most directly embeddable MVP is **two docs stills**:
  - `accounts-pending` (or `cloud-link-pending`) — Settings → DorkOS account,
    pending: the 8-char code, "Open dorkos.ai/activate", "Waiting for you to
    approve…".
  - `accounts-linked` (or `cloud-link-linked`) — the same panel flipped:
    green dot, "Linked", the account label, "Last synced just now".
- **Driven how:** a `shootCloudLink*` pair in `surfaces-desktop.ts`, added to
  `captureLightStills`. Navigate `url('/agents?settings=account')` (or `/`),
  wait the panel, click **Link this instance**, wait the `PendingState`
  selector (the code) → shoot `accounts-pending`; then wait the `LinkedState`
  selector ("Linked" / green dot) → shoot `accounts-linked`. The fake's
  auto-flip lands the linked state within a couple of client poll ticks
  (2500ms), so the harness just waits the selector — no arbitrary sleeps. Pin a
  deterministic `user_code` + account label in `config.ts`.
- **Where they embed:** `docs/self-hosting/dorkos-accounts.mdx` → "Linking from
  Settings": `<ProductShot id="accounts-pending" />` at the "Link this instance"
  step and `<ProductShot id="accounts-linked" />` at the "Approve, and watch it
  flip" step. Register both shots with `consumers: ['docs']` (they never appear
  on `/features` unless tagged `marketing`). `shots.test.ts` /`features.test.ts`
  then enforce the registry ↔ docs-embed ↔ files agreement.
- **Alternative (defer):** a single `loop` capturing the flip in one clip. It is
  the most literal reading of "the pending→linked shot," but a loop needs
  careful seam/timing handling (the fake must hold pending long enough to record
  the code, then flip inside the loop window) and loops are marketing-weighted.
  Recommend two docs stills for MVP; a flip loop is a clean follow-up once the
  seam exists.

**Scope check (is this still worth size 3?).** Yes, and 3 is right:

- **Server (the bulk):** the fake `FetchLike` factory (a scenario-sized file) +
  the construction seam + the guard test. This is the "real server engineering
  that deserves a design note + review" the brief calls out — small but not
  trivial, and it deserves a **draft ADR** (the composition seam + the test-mode
  cloud transport is an architecture decision, like the `TestModeRuntime`
  precedent).
- **Capture:** 2 registry entries + 1 drive pair + 2 pinned config values.
- **Docs:** 2 `<ProductShot>` embeds.
- **Guards:** the existing media-guard tests pick up the new shots.
  No new infra, no new config field, and the injectable seams already exist —
  so it does not exceed size 3, and the design-note + capture + docs surface
  justify not dropping it to size 2.

**Is the docs embed part of THIS issue or DOR-283's?** **This issue.** The brief
scopes DOR-301 as "seam → capture drive → docs embed in
`docs/self-hosting/dorkos-accounts.mdx`." DOR-283 is the parent docs-media
umbrella and explicitly parked only the **/account/instances table in
`apps/site`** as out of scope. So DOR-301 owns the pending/linked shots and their
embed in the accounts docs page end to end.

## 5) Decisions

Resolved during ideation (what the evidence settles). The one genuinely open,
scope-shaping choice is in §6.

| #   | Decision                                     | Choice                                                                                                                                            | Rationale                                                                                                                                          |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Keep the goal (photograph the flip offline)? | Yes                                                                                                                                               | The flip is real + verified; only the offline-capture path is missing. It is a capture seam, not a new feature.                                    |
| 2   | What does the stub fake?                     | Only the `FetchLike` transport to dorkos.ai (device code + token poll + heartbeat)                                                                | Fakes exactly the network dependency; state machine, persistence, routes, client all run for real — the demo-scenarios honesty model.              |
| 3   | Where the fake lives                         | `services/runtimes/test-mode/<fake-cloud-link>.ts`, inside the test-mode boundary next to `demo-scenarios.ts`                                     | Same boundary, same gate, same pattern as the agent-backend fake.                                                                                  |
| 4   | The gate                                     | `DORKOS_TEST_RUNTIME` (already on in capture/e2e, off in all production paths)                                                                    | The established test-mode gate (test-control routes, `TestModeRuntime`, demo scenarios).                                                           |
| 5   | Wiring / composition edge                    | Reseat the `cloudLinkManager` singleton to a construction seam; `index.ts` injects the fake `fetchImpl` under the `DORKOS_TEST_RUNTIME` branch    | Mirrors `TestModeRuntime` registration; keeps production `cloud-link.ts` free of test branches and imports. Rejects the env-branch-in-prod option. |
| 6   | Unreachability enforcement                   | Dynamic import in the gated branch **+** a throwing guard in the factory **+** a test asserting prod uses real `fetch` and never imports the fake | The honesty line must be asserted, not assumed — layered structural + runtime + test defenses.                                                     |
| 7   | Auto-flip mechanism                          | Fake token endpoint returns `authorization_pending` briefly, then `{access_token}`; no human Approve                                              | Deterministic, offline flip; the client's 2500ms poll then flips the panel to linked on the next tick.                                             |
| 8   | Shot set (MVP)                               | Two docs stills: `accounts-pending` (code visible) + `accounts-linked`; `consumers: ['docs']`                                                     | Directly embeddable at the two Settings `<Step>`s; simplest, lowest-timing-risk. Flip loop deferred (§6).                                          |
| 9   | Docs embed ownership                         | In scope for DOR-301 (`dorkos-accounts.mdx`)                                                                                                      | The brief scopes the embed to this issue; only the site /account/instances table is DOR-283-parked.                                                |
| 10  | Deterministic content                        | Pin `user_code` + `accountLabel` in `config.ts`; heartbeat `lastSeenAt` ≈ now ("just now")                                                        | Art-direction rule — no `Date.now()` churn between runs; the pending/linked stills stay byte-stable.                                               |
| 11  | Design note / ADR                            | Draft an ADR for the test-mode cloud transport + construction seam at SPECIFY                                                                     | "Real server engineering … deserves a design note + review" — matches the `TestModeRuntime`/test-control precedent.                                |

## 6) Open Questions (for SPECIFY)

1. **Shot shape: two stills, or add the flip loop?** MVP recommends two docs
   stills (`accounts-pending` + `accounts-linked`) embedded at the two Settings
   steps — simplest and lowest timing-risk. The most literal reading of "the
   pending→linked shot" is a single **loop** of the in-place flip, which is more
   compelling but needs the fake to hold pending long enough to record the code
   then flip inside the loop window, and loops carry the marketing weight/size
   budget. **Recommended default:** ship the two stills now; file the flip loop
   as a follow-up once the seam is in. SPECIFY to confirm (and, if it takes the
   loop, to pin the pending-hold duration against the loop length + the client's
   2500ms poll).

## 7) Recommended Direction & Next Step

**Direction:** Add a `DORKOS_TEST_RUNTIME`-gated **fake `FetchLike`** for the
cloud device flow, living in the test-mode boundary next to `demo-scenarios.ts`,
and reseat the `cloudLinkManager` singleton to a small **construction seam** so
`index.ts` injects the fake at the composition root — exactly mirroring how it
swaps in `TestModeRuntime`. The fake scripts the four device-flow endpoints
(canned device code with a pinned `user_code`; `authorization_pending` then an
auto-issued access token; a heartbeat with a seeded account label), so the real
state machine, token persistence, routes, and client panel drive the genuine
pending → linked flip **offline, with zero calls to dorkos.ai**. Assert the
honesty line with a dynamic-import-under-the-gate structure, a throwing factory
guard, and a test that production uses the real `fetch` and never imports the
fake. Then register two docs stills (`accounts-pending`, `accounts-linked`),
add a `shootCloudLink*` drive that navigates `?settings=account`, clicks **Link
this instance**, and photographs the pending then the linked state, and embed
both via `<ProductShot>` in `docs/self-hosting/dorkos-accounts.mdx`. Explicitly
**do not** env-branch inside production `cloud-link.ts`, **do not** point at a
real/staging cloud URL, and **do not** touch the /account/instances site table
(DOR-283).

**Next step:** Proceed to **SPECIFY**. The spec must (1) draft the ADR for the
test-mode cloud transport + the `cloudLinkManager` construction seam (the "design
note + review" the brief asks for), pinning the exact accessor/holder shape;
(2) fix the fake's endpoint contract and the auto-flip window; (3) resolve Open
Question 1 (two stills vs flip loop) and pin the deterministic `user_code` /
account label in `config.ts`; and (4) specify the unreachability guard test.
Server work is the bulk; the capture drive and docs embed are low-risk once the
seam exists.
