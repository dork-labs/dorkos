---
slug: capture-cloud-link-stub
id: 260717-191228
created: 2026-07-17
status: specified
linearIssue: DOR-301
---

# Test-mode cloud-link stub for the Accounts pending→linked capture shot

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Niépce (SPECIFY stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-301 · type idea→design · size 3 · Low · split from DOR-283 (docs media)

## Overview

The Settings → **DorkOS account** panel really does flip _pending → linked_ in
place: click **Link this instance**, a device code appears, and when the link is
approved the same panel updates to a green **Linked** with the account label and
"Last synced just now". That flip is real, shipped, and verified end-to-end
(`specs/accounts-and-auth` + `specs/cloud-account-management`), and the docs page
already narrates it ("Approve, and watch it flip"). The one missing piece is a
**truthful way to photograph it inside the offline capture stack**, which by
design holds no real cloud credentials and must never touch the operator's real
`dorkos.ai` account.

The blocker is precise:
`CloudLinkManager.startLink()` calls the real `fetch` against
`https://dorkos.ai`, and the flip to `linked` normally needs a human clicking
**Approve** on the live site. Neither is reachable — or allowed — inside the
capture sandbox.

This spec freezes a **capture-enablement seam**, not a new product feature. It
does exactly what `demo-scenarios.ts` does for the agent backend, but for the
cloud network: it fakes **one** thing — the `FetchLike` HTTP transport to
`dorkos.ai` — and lets the **real** state machine, the real token persistence,
the real poll loop, the real heartbeat, all four `/api/cloud/*` routes, and the
real client panel run against canned responses. It fakes the network dependency
and nothing else. The fake is gated behind `DORKOS_TEST_RUNTIME` (already on in
capture and e2e, off in every production path), reached only through a dynamic
`import()` at the composition root, and guarded so it throws if ever constructed
outside the gate — so a shipped binary can never link against it.

Two pieces of work fall out of that:

1. **A small, reviewable construction seam.** The `CloudLinkManager` already
   accepts an injectable `fetchImpl` — but the process-wide instance is an
   **eagerly-constructed module singleton** (`export const cloudLinkManager = new
CloudLinkManager()`), so there is no composition point that can inject the
   fake today. The honest fix — mirroring how `index.ts` swaps in
   `TestModeRuntime` under `DORKOS_TEST_RUNTIME` — is to reseat the singleton to a
   construction seam at the composition root. This is behavior-preserving in
   production (real `fetch`, real defaults). It is the "real server engineering
   that deserves a design note + review" the brief calls out, and it earns a
   draft ADR.

2. **The capture + docs surface.** Register two docs stills (`accounts-pending`,
   `accounts-linked`), add a drive that opens `?settings=account`, clicks **Link
   this instance**, photographs the pending state, waits for the fake's auto-flip,
   photographs the linked state, and embed both via `<ProductShot>` in
   `docs/self-hosting/dorkos-accounts.mdx`.

The ideation's one genuinely open, scope-shaping question (Open Q1 — two stills
vs. a flip loop) is resolved here: **two docs stills for the MVP; a flip loop is
a clean follow-up once the seam exists.**

## Background / Problem Statement

All line numbers verified against the codebase on 2026-07-17.

- **The state machine already threads an injectable transport — the fake is a
  drop-in.** `CloudLinkManager.startLink()`
  (`apps/server/src/services/core/auth/cloud-link.ts:179`) calls
  `resolveCloudBaseUrl()` (`:181`) then `requestDeviceCode({ baseUrl, descriptor,
fetchImpl: this.fetchImpl })` (`:187`), sets `pending` (`:189`), and kicks off
  `runPoll` (`:201`), which calls `pollForToken({ …, fetchImpl: this.fetchImpl })`
  (`:208-217`) and, on `approved`, `config.save({ instanceToken })` +
  `setState('linked')` + `heartbeat(...)` (`:219-223`). Every network call routes
  through `this.fetchImpl`. `CloudLinkManagerOptions` (`:122-135`) already exposes
  `fetchImpl?: FetchLike`. So injecting a fake `fetchImpl` at construction is the
  **entire** server-side wiring — no branch inside `cloud-link.ts`.

- **The exact `FetchLike` contract the fake must satisfy** is the pure client in
  `apps/server/src/services/core/auth/cloud-link-client.ts`. `FetchLike` is
  `(input: string, init?: RequestInit) => Promise<Response>` (`:40`). Four
  endpoints:
  1. `POST {base}/api/auth/device/code` → `DeviceCodeResponse` (`:64-72`:
     `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`,
     `expires_in`, `interval`); throws on non-2xx (`:152-154`).
  2. `POST {base}/api/auth/device/token` → `200 {access_token}` on success
     (`:205-209`), or `400 {error}` in `{authorization_pending | slow_down |
access_denied | expired_token | invalid_grant}` (`:212-227`). `pollForToken`
     sleeps `interval` seconds **before** each poll (`:191`) and treats
     `authorization_pending` as "keep looping" (`:215`).
  3. `POST {base}/api/instances/heartbeat` (Bearer) → `200 {instanceId,
lastSeenAt, accountLabel}` (`:274-284`); `401` = unlinked (`:272`); never
     throws for HTTP-level failures.
  4. `POST {base}/api/instances/revoke` (Bearer) → `res.ok` (`:300-318`);
     best-effort, swallows all failures.

- **The composition problem: an eagerly-constructed module singleton.**
  `export const cloudLinkManager = new CloudLinkManager()`
  (`cloud-link.ts:369`). It is imported **as a value** by exactly two
  non-test modules: `apps/server/src/routes/cloud.ts:14` (used in all four
  handlers — `:22, :34, :40, :50`) and `apps/server/src/index.ts:26` (used at
  `:1430` `initOnStartup()` and `:1479` `stop()`). There is no injection point:
  both import the already-constructed instance. This is why "just inject the
  fetchImpl" is impossible today, and why a construction seam is required.

- **The precedent for the seam is already in `index.ts`.** The runtime
  registration block (`index.ts:440-469`, inside `async function start()` at
  `:169`) is env-gated composition-root substitution via dynamic import:
  `if (env.DORKOS_TEST_RUNTIME) { const { TestModeRuntime } = await
import('./services/runtimes/test-mode/test-mode-runtime.js'); … } else { …
ClaudeCodeRuntime … }`. This block runs **before** `cloudLinkManager.
initOnStartup()` at `:1430` (same `start()` function), so a
  `initCloudLinkManager(...)` call placed there is guaranteed to construct the
  manager before startup or any request touches it.

- **The honesty template is `demo-scenarios.ts`.** Its module doc
  (`apps/server/src/services/runtimes/test-mode/demo-scenarios.ts:7-15`): "These
  exist ONLY to stage beautiful, truthful UI … reachable only when
  `DORKOS_TEST_RUNTIME=true` … Nothing here is wired into production." The stub is
  its cloud-network sibling: same directory, same gate, same never-in-production
  posture. The unreachability pattern to copy is `routes/test-control.ts:11-12`
  ("Only mounted when DORKOS_TEST_RUNTIME=true. Returns 404 … in production") and
  its dynamic-import note (`:44-50`).

- **The capture stack is offline and must stay that way.**
  `apps/e2e/capture/boot.ts` `baseEnv()` (`:38-61`) sets
  `DORKOS_TEST_RUNTIME='true'` (`:42`), an isolated `DORK_HOME=CAPTURE_HOME`
  (`:48`), and a pinned `DORKOS_BOUNDARY` (`:53`) — but it does **not** set
  `DORKOS_CLOUD_URL`. So `resolveCloudBaseUrl()`
  (`cloud-link-client.ts:94-96`) returns the real `https://dorkos.ai`. A real
  `fetch` would escape the sandbox. This is precisely why the fake must
  **intercept the transport** (return canned `Response`s regardless of the base
  URL), not point at a staging URL. Zero packets leave the process.

- **The client renders the two money states and polls on a fixed cadence.**
  `apps/client/src/layers/features/cloud-link/ui/CloudLinkPanel.tsx`:
  - `IdleState` (`:126-208`) shows the **Link this instance** button (`:193-200`).
  - `PendingState` (`:210-246`) shows "Enter this code to link" (`:217`), the big
    mono `userCode` in a `<code>` (`:219-221`), **Open dorkos.ai/activate**
    (`:232-238`), and a `role="status"` "Waiting for you to approve on
    dorkos.ai…" (`:240-243`).
  - `LinkedState` (`:248-307`) shows a green dot (`:263`), "Linked" (`:264`), the
    `accountLabel` (`:266-268`), and "Last synced {relativeTime}" (`:271-275`).
    The panel opens to the account tab by URL deep-link: `SettingsDialog` tab id
    `'account'` (`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:43`)
    renders `CloudAccountTab` → `CloudLinkPanel`; `?settings=account`
    (`dialog-search-schema.ts:19`, `settings: z.string().optional()`) opens it.
    The client polls `GET /api/cloud/link/status` every **2500ms**
    (`use-cloud-link.ts:25`, `POLL_INTERVAL_MS`) while `pending`, stopping on
    terminal states (`:28`, `TERMINAL_STATES`). Crucially, `start()` sets
    `pending` **optimistically** the instant `POST /link/start` returns
    (`:146-149`), so the pending view is on screen immediately after the click and
    stays there for at least one full 2500ms status tick — the pending still is not
    timing-sensitive.

- **The capture registry + guards are the source of truth.**
  `apps/e2e/capture/shots.ts` is the registry (`Shot` = `{ id, kind, frame,
consumers, … }`, `:47-74`); docs-only shots list `consumers: ['docs']` and
  never appear on `/features` (`:122-131`, e.g. `marketplace-detail`, `workbench`).
  Two guards enforce the registry ↔ docs ↔ files agreement:
  `apps/e2e/capture/__tests__/shots.test.ts` (registry invariants + the
  `SHARD_0_PINNED_SHOTS` equality at `:106-111`), and — the load-bearing one —
  `apps/site/src/layers/features/marketing/lib/__tests__/shots.test.ts:106-142`:
  it scans every `<ProductShot id="…">` in `docs/**` and asserts each id is
  registered in the **published** manifest, has its `-light.png` present in
  `apps/site/public/product/`, and declares `'docs'` in its consumers. **This is a
  sequencing constraint (see Implementation Phases): the docs embeds cannot land
  green until a real capture+process run has published the two PNGs and the
  manifest.**

- **The `dorkos cloud` CLI is unaffected.** `cloud-link.ts:16-17`: the CLI runs
  the same device flow "headlessly against the client primitives directly (no
  running server), so it does not use this singleton." The seam touches only the
  server singleton; the CLI path is untouched.

## Decisions (LOCKED from ideation)

Carried forward verbatim from `01-ideation.md` §5; not reopened.

1. **Keep the goal** — photograph the real pending→linked flip offline. It is a
   capture seam over a verified surface, not a new feature.
2. **What the stub fakes:** only the `FetchLike` transport to `dorkos.ai` (device
   code + token poll + heartbeat + revoke). State machine, persistence, routes,
   and client all run for real.
3. **Where the fake lives:** in the test-mode boundary next to
   `demo-scenarios.ts` (`services/runtimes/test-mode/`).
4. **The gate:** `DORKOS_TEST_RUNTIME` — the established test-mode gate
   (test-control routes, `TestModeRuntime`, demo scenarios).
5. **Wiring:** reseat the `cloudLinkManager` singleton to a construction seam;
   `index.ts` injects the fake `fetchImpl` under the `DORKOS_TEST_RUNTIME` branch.
   Reject env-branching inside production `cloud-link.ts`.
6. **Unreachability enforcement:** dynamic import under the gate **+** a throwing
   factory guard **+** a test asserting prod uses real `fetch` and never imports
   the fake.
7. **Auto-flip mechanism:** the fake token endpoint returns
   `authorization_pending` briefly, then `{access_token}` — no human Approve.
8. **Shot set (MVP):** two docs stills, `accounts-pending` + `accounts-linked`,
   `consumers: ['docs']`.
9. **Docs embed ownership:** in scope for DOR-301 (`dorkos-accounts.mdx`); only
   the site `/account/instances` table is DOR-283-parked.
10. **Deterministic content:** pin the `user_code` + `accountLabel` (heartbeat
    `lastSeenAt` ≈ now → "just now").
11. **Design note / ADR:** seed an ADR for the test-mode cloud transport +
    construction seam.

## Decisions resolved in SPECIFY

- **Open Q1 — two stills vs. a flip loop. RESOLVED: two docs stills for the MVP;
  the flip loop is a follow-up.** The two stills embed directly at the two
  "Linking from Settings" `<Step>`s, carry the lowest timing risk (the pending
  view renders optimistically on click, so it is never missed), and match the
  established docs-still consumers pattern. A single `loop` of the in-place flip
  is the more literal reading and more compelling, but a loop needs the fake to
  hold `pending` long enough to record the code and then flip inside the loop
  window, and loops carry marketing weight and a larger size budget. Filed as a
  follow-up at DONE.

- **Seam shape — the accessor pair, not a mutable export. RESOLVED.** The
  codebase has two singleton-reseat precedents:
  - `configManager` (`services/core/config-manager.ts:840-846`): `export let
configManager: ConfigManager` + `initConfigManager(dorkHome)`; routes import
    the live binding directly, no accessor, **no pre-init guard**.
  - `getWorkspaceManager` / `setWorkspaceManager`
    (`services/workspace/index.ts:71-82`): an accessor pair with a **throwing
    guard** (`if (!active) throw new Error('WorkspaceManager not initialized')`);
    its docstring states it is "the module-singleton the routes read … mirrors the
    `runtimeRegistry` access idiom."

  **Choice: the accessor pair.** Add `initCloudLinkManager(options?:
CloudLinkManagerOptions): CloudLinkManager` and `getCloudLinkManager():
CloudLinkManager` (throws if uninitialized); remove `export const
cloudLinkManager`. Rationale: it is the newer, purpose-built precedent for
  exactly "a module singleton the routes read, reseated at bootstrap"; the
  throwing guard turns any pre-init access into a loud, helpful error rather than
  the silent `undefined` deref a bare `export let` risks (the "errors helpful"
  quality bar). The `configManager` mutable-export pattern is **considered and
  rejected** here: it is a foot-gun (a mutable export that is `undefined` until
  boot) and its init takes a required argument so it can never be read
  pre-init — cloud-link's options are optional, so the guard matters more.

- **Determinism lives in the fake, not `apps/e2e/capture/config.ts`. RESOLVED
  (correction to ideation Decision 10).** The ideation said to pin `user_code`
  and `accountLabel` in `config.ts`. But `config.ts` is the **capture harness's**
  module (`apps/e2e`), and the fake runs **in the server process** (`apps/server`)
  — a different package; the server cannot and must not import the e2e config.
  The pinned constants therefore live as module constants **in the fake**
  (`fake-cloud-link.ts`). This is safe because the drive waits on **selectors**
  (the code element, the "Linked" text), never on the exact code string, so the
  harness does not need the values; the exact-value assertions live in the fake's
  server-side unit test. Net effect: **`config.ts` gets no new pinned values.**

- **The throwing guard checks the validated boolean, not the raw string.
  RESOLVED (correction to ideation).** `env.DORKOS_TEST_RUNTIME` is validated as a
  **boolean** (`apps/server/src/env.ts:90-93`: `z.string().optional().transform(v
=> v === 'true')`). The guard is `if (!env.DORKOS_TEST_RUNTIME) throw …`, not
  the ideation's `!== 'true'` (which compares against a raw string that the
  validated env no longer is).

## Goals

- Add `initCloudLinkManager(options?)` + `getCloudLinkManager()` to
  `services/core/auth/cloud-link.ts`, remove the eager `export const
cloudLinkManager`, and route `routes/cloud.ts` + `index.ts` through the
  accessor. Production construction is behavior-preserving (no options → real
  `fetch`, real defaults).
- Add a `DORKOS_TEST_RUNTIME`-gated fake `FetchLike` factory,
  `createFakeCloudLinkFetch()`, at
  `services/runtimes/test-mode/fake-cloud-link.ts`, scripting the four device-flow
  endpoints with pinned deterministic content and a call-counted auto-flip.
- Wire the fake at the composition root: inside the existing `if
(env.DORKOS_TEST_RUNTIME)` block in `index.ts`, `await import()` the factory and
  `initCloudLinkManager({ fetchImpl: createFakeCloudLinkFetch() })`; the
  production `else` branch calls `initCloudLinkManager()` (no options).
- Assert the honesty line with three layered defenses: dynamic import under the
  gate (structural), a throwing factory guard (runtime), and tests that (a) the
  prod-default construction uses the real `globalThis.fetch` and never the fake,
  and (b) production `cloud-link.ts` / `cloud-link-client.ts` / `routes/cloud.ts`
  never import the fake module (import-graph assertion).
- Register two docs stills — `accounts-pending`, `accounts-linked` (`kind:
'still'`, `frame: 'desktop'`, `consumers: ['docs']`) — in
  `apps/e2e/capture/shots.ts`, pinned to one shard so the single-flow pair never
  splits.
- Add a `shootCloudLink` drive in `apps/e2e/capture/surfaces-desktop.ts` that
  opens `?settings=account`, clicks **Link this instance**, shoots the pending
  state, waits the fake's auto-flip, and shoots the linked state.
- Embed both stills via `<ProductShot>` at the two "Linking from Settings"
  `<Step>`s in `docs/self-hosting/dorkos-accounts.mdx` (after a real capture run
  publishes the assets).
- Seed a draft ADR for the test-mode cloud transport + the construction seam.

## Non-Goals

- **The `/account/instances` registry table in `apps/site`.** Explicitly parked
  out on DOR-283 — a Next.js site surface, not the isolated cockpit capture. Not
  photographed by this pipeline.
- **Any change to the production device flow.** The RFC 8628 logic in
  `cloud-link-client.ts`, the token persistence (`cloud.instanceToken`
  sensitive-field), the heartbeat/expiry logic, all four `/api/cloud/*` routes,
  and the entire client panel + poll run **unchanged**. The only production edit
  is **how the singleton is constructed** (reseated to the root), which is
  behavior-preserving with no options.
- **Faking the cloud as a real HTTP server.** The fake is an in-process
  `FetchLike` (like demo-scenarios fakes the stream), not a network listener on a
  port. Rejected: heavier, adds a socket + port to the sandbox, and diverges from
  the in-process demo pattern for no gain — we already own the `fetchImpl` seam.
- **Env-branching the default transport inside `cloud-link.ts`.** Rejected: it
  puts an `if (test)` branch and a test-mode import into a production auth module
  and drags the fake into the production build.
- **A flip loop, or an unlink/relink shot.** The loop is a filed follow-up; the
  fake handles `revoke` and per-device-code counting so a future unlink shot is
  cheap, but neither ships here.
- **Standing up a real linked account against staging.** A live, non-deterministic
  dependency — the opposite of the offline capture contract.
- **A changelog fragment** (see Documentation — the honest call is NONE).

## Technical Dependencies

- No new external dependencies. The fake returns platform `Response` objects
  (Node 22/24 global `Response`); the manager already threads `fetchImpl`.
- No new config field. `DORKOS_TEST_RUNTIME` (`apps/server/src/env.ts:90-93`) is
  the gate — already on in capture (`boot.ts:42`) and e2e, off in every
  production path.
- No OpenAPI change (no route added, removed, or reshaped).
- `ProductShot` is a global MDX component (no import line in docs pages — verified
  across `docs/**`), so the embeds add only two component tags.

## Detailed Design

### 1. Server — the construction seam (accessor pair)

In `apps/server/src/services/core/auth/cloud-link.ts`, replace the eager
singleton (`:369`) with an accessor pair that mirrors
`get/setWorkspaceManager`:

```ts
let instance: CloudLinkManager | undefined;

/**
 * Construct the process-wide cloud-link manager. Called once at the composition
 * root ({@link start} in `index.ts`): with no options in production (real
 * `fetch`, real defaults), or with an injected fake `fetchImpl` under
 * `DORKOS_TEST_RUNTIME`. Returns the constructed instance.
 */
export function initCloudLinkManager(options?: CloudLinkManagerOptions): CloudLinkManager {
  instance = new CloudLinkManager(options);
  return instance;
}

/**
 * The process-wide cloud-link manager used by the `/api/cloud/*` routes and
 * startup. Throws if read before {@link initCloudLinkManager} runs — a loud,
 * helpful failure instead of a silent `undefined` dereference.
 */
export function getCloudLinkManager(): CloudLinkManager {
  if (!instance) throw new Error('CloudLinkManager not initialized');
  return instance;
}
```

- The `CloudLinkManager` class and `CloudLinkManagerOptions` are **unchanged** —
  the constructor already accepts `fetchImpl` (`:157-165`) and defaults it to the
  real transport when absent (`cloud-link-client.ts:86`, `defaultFetch =
globalThis.fetch`). So `initCloudLinkManager()` with no options reproduces
  today's behavior byte-for-byte.
- **`routes/cloud.ts`**: replace the value import (`:14`) and the four call sites
  (`:22, :34, :40, :50`) with `getCloudLinkManager()` — e.g.
  `const result = await getCloudLinkManager().startLink();`. The routes stay thin;
  the handlers already run only post-boot, so the guard never trips in practice.
- **`index.ts`**: drop the value import (`:26`); call `getCloudLinkManager().
initOnStartup()` (`:1430`) and `getCloudLinkManager().stop()` (`:1479`); add the
  `initCloudLinkManager(...)` call in the runtime-registration block (§3).

### 2. Server — the fake `FetchLike` (`services/runtimes/test-mode/fake-cloud-link.ts`)

A new module next to `demo-scenarios.ts`, exporting a factory that returns a
`FetchLike` intercepting by pathname (base URL ignored, since capture keeps the
real `https://dorkos.ai`). It imports `type FetchLike` / `type DeviceCodeResponse`
from `../../core/auth/cloud-link-client.js` (type-only, erased at runtime; the
fake→prod direction is allowed) and `env` from `../../../env.js`.

**Pinned deterministic constants (the art-direction rule — no `Date.now()` in
anything a screenshot shows):**

```ts
/** Pending code shown in the panel (8 chars, hyphen-grouped like RFC 8628 user codes). */
const FAKE_USER_CODE = 'DORK-2F7Q';
/** Account label shown in the linked view. */
const FAKE_ACCOUNT_LABEL = 'Dork Labs';
/** Opaque device code (never shown in the UI). */
const FAKE_DEVICE_CODE = 'fake-device-code';
/** Fake scoped instance key persisted at `cloud.instanceToken` (never shown or logged). */
const FAKE_ACCESS_TOKEN = 'fake-instance-key';
/** Fake instance id echoed by the heartbeat. */
const FAKE_INSTANCE_ID = 'capture-instance';
/** Server-side poll cadence (`DeviceCodeResponse.interval`, seconds). */
const DEVICE_CODE_INTERVAL_SECONDS = 1;
/** Long enough that the code never visibly expires mid-capture (seconds). */
const DEVICE_CODE_EXPIRES_IN_SECONDS = 900;
/** Token polls answered `authorization_pending` before the fake approves. */
const PENDING_POLLS_BEFORE_APPROVAL = 2;
```

**The factory + guard:**

```ts
/**
 * A `DORKOS_TEST_RUNTIME`-only fake of the DorkOS cloud device-flow transport.
 * Scripts the four device-flow endpoints in-process so the real
 * {@link CloudLinkManager} drives a genuine pending→linked flip offline, with
 * ZERO packets to dorkos.ai. Mirrors how `demo-scenarios.ts` fakes the agent
 * backend: it fakes the network dependency and nothing else.
 *
 * @throws If constructed outside `DORKOS_TEST_RUNTIME` — the fake must be
 *   unreachable in production (structural gate + this runtime guard + tests).
 */
export function createFakeCloudLinkFetch(): FetchLike {
  if (!env.DORKOS_TEST_RUNTIME) {
    throw new Error('createFakeCloudLinkFetch is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  // Poll count per device_code, so each link cycle flips independently and a
  // future unlink→relink drive is deterministic (a fresh code resets the count).
  const pollCounts = new Map<string, number>();

  return async (input, init) => {
    const { pathname } = new URL(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (pathname.endsWith('/api/auth/device/code')) {
      return json(200, {
        device_code: FAKE_DEVICE_CODE,
        user_code: FAKE_USER_CODE,
        verification_uri: 'https://dorkos.ai/activate',
        verification_uri_complete: `https://dorkos.ai/activate?code=${FAKE_USER_CODE}`,
        expires_in: DEVICE_CODE_EXPIRES_IN_SECONDS,
        interval: DEVICE_CODE_INTERVAL_SECONDS,
      } satisfies DeviceCodeResponse);
    }

    if (pathname.endsWith('/api/auth/device/token')) {
      const { device_code } = JSON.parse(String(init?.body ?? '{}')) as { device_code?: string };
      const key = device_code ?? FAKE_DEVICE_CODE;
      const seen = pollCounts.get(key) ?? 0;
      pollCounts.set(key, seen + 1);
      if (seen < PENDING_POLLS_BEFORE_APPROVAL) {
        return json(400, { error: 'authorization_pending' });
      }
      return json(200, { access_token: FAKE_ACCESS_TOKEN });
    }

    if (pathname.endsWith('/api/instances/heartbeat')) {
      return json(200, {
        instanceId: FAKE_INSTANCE_ID,
        lastSeenAt: new Date().toISOString(), // ≈ now → renders "just now" (stable string)
        accountLabel: FAKE_ACCOUNT_LABEL,
      });
    }

    if (pathname.endsWith('/api/instances/revoke')) {
      return json(200, {});
    }

    // Fail loud: an unknown path is a wiring bug, never a silent escape.
    throw new Error(`fake cloud-link: unexpected request ${pathname}`);
  };
}
```

**Timing — how the flip lands on camera (traced end-to-end):**

1. Click **Link this instance** → `POST /api/cloud/link/start` →
   `getCloudLinkManager().startLink()` → fake `device/code` (pending) → returns
   codes. The client sets `pending` **optimistically** on return
   (`use-cloud-link.ts:146-149`) and starts its 2500ms status poll. **The pending
   view is on screen immediately** — the harness `waitFor(pending)` succeeds at
   once and the still is captured with no race.
2. Server `runPoll` sleeps `interval` (1s) → `device/token` poll #1 → pending →
   sleep 1s → poll #2 → pending → sleep 1s → poll #3 → `{access_token}`. The
   manager saves the token, sets `linked`, and heartbeats (fake → account label +
   "just now"). Server-side approval lands at **~3s**.
3. The client's status poll (every 2500ms) sees `linked` on its next tick after
   ~3s (≤ ~5s total) → renders `LinkedState`. The harness `waitFor('Linked')`
   catches it; the linked still is captured.

The `PENDING_POLLS_BEFORE_APPROVAL = 2` window guarantees the server does not flip
before the client has shown pending for at least one 2500ms tick, and keeps the
whole flip inside ~5s (in line with demo-scenarios' single-digit-second pacing).
No arbitrary sleeps in the drive — the harness waits selectors.

### 3. Server — composition-root wiring (`index.ts`)

Extend the existing runtime-registration block (`:440-469`, inside `start()`):

```ts
if (env.DORKOS_TEST_RUNTIME) {
  // … existing TestModeRuntime registration …
  const { createFakeCloudLinkFetch } =
    await import('./services/runtimes/test-mode/fake-cloud-link.js');
  initCloudLinkManager({ fetchImpl: createFakeCloudLinkFetch() });
} else {
  // … existing ClaudeCodeRuntime registration …
  initCloudLinkManager(); // real fetch, real defaults — behavior-preserving
}
```

- Dynamic `import()` keeps `fake-cloud-link.ts` **out of the production module
  graph** — exactly like `TestModeRuntime` (`:442`) and the test-control reset
  path (`test-control.ts:44-50`).
- This runs before `getCloudLinkManager().initOnStartup()` (`:1430`) and any
  request, so the accessor's guard never trips.
- In test mode the isolated capture `config.json` holds no `cloud.instanceToken`,
  so `initOnStartup()` returns early (`cloud-link.ts:240-241`) and never
  heartbeats until the drive links — no interference with other shots.

### 4. Unreachability — asserting the honesty line

Three layered defenses (Decision 6):

- **Structural:** the fake is imported **only** by the composition root's
  `if (env.DORKOS_TEST_RUNTIME)` branch, via dynamic `import()`. It is never a
  static import of any production module, so it is absent from a shipped build's
  graph.
- **Runtime guard:** `createFakeCloudLinkFetch()` throws unless
  `env.DORKOS_TEST_RUNTIME` is true (the validated boolean).
- **Test:** see Testing Strategy — a prod-default-construction test (real
  `globalThis.fetch`, no fake) and an import-graph test (production auth modules
  never name the fake).

### 5. Capture — the two docs stills + the drive

**Registry** (`apps/e2e/capture/shots.ts`), added to the "docs-only" block
(`:122-131`):

```ts
{ id: 'accounts-pending', kind: 'still', frame: 'desktop', consumers: ['docs'] },
{ id: 'accounts-linked', kind: 'still', frame: 'desktop', consumers: ['docs'] },
```

**Single-flow, single-shard.** Both stills come from **one** linear device flow
(link → pending → auto-flip → linked), so they must ride the **same shard** — a
round-robin split (`partitionShots`, `:215-228`) would put them on different
stacks and break the flow. Pin **both** ids to `SHARD_0_PINNED_SHOTS` (`:196-200`)
— the same single-stack rationale the session-list shots already use — and guard
the drive with a single `isShotSkipped('accounts-pending')`. Update the
`SHARD_0_PINNED_SHOTS` equality assertion in
`apps/e2e/capture/__tests__/shots.test.ts:109` to include the two ids.

**The drive** (`apps/e2e/capture/surfaces-desktop.ts`), one function that captures
both stills in a single flow (selectors verified against `CloudLinkPanel.tsx`):

```ts
/** Open Settings → DorkOS account, link, and shoot the pending then linked states. */
async function shootCloudLink(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/agents?settings=account'));
  await page.getByRole('heading', { name: 'DorkOS account' }).waitFor({ timeout: WAIT_MS });
  await page.getByRole('button', { name: 'Link this instance' }).click({ timeout: WAIT_MS });

  // Pending: the code + the "waiting" status render immediately (optimistic).
  await page
    .getByText('Waiting for you to approve', { exact: false })
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'accounts-pending', theme, rec);

  // Linked: the fake auto-flips; the client's 2500ms status poll lands "Linked"
  // within a couple of ticks. Wait the money state — no arbitrary sleep.
  await page.getByText('Linked', { exact: true }).waitFor({ timeout: WAIT_MS });
  await page.getByText('Dork Labs', { exact: false }).waitFor({ timeout: WAIT_MS });
  await shoot(page, 'accounts-linked', theme, rec);
}
```

Invoke it once from `captureLightStills` (`:560-606`), guarded so the single-flow
pair rides shard 0 as a unit:

```ts
if (!isShotSkipped('accounts-pending')) {
  await attempt('accounts (pending→linked)', () => shootCloudLink(page, theme, rec));
}
```

Place the call **at the end** of the light-stills batch: linking persists a token
into the isolated capture config, and running last keeps that state from bleeding
into any earlier surface. (A dedicated exported `captureCloudLink(browser, rec)`
mini-context, modeled on `captureAgentDiscovery` at `:526-552`, is an equally
valid EXECUTE-time shape; either satisfies the single-shard requirement. The
recommendation is the in-batch call above for simplicity.)

**`config.ts`: no new pinned values** (see Decisions resolved — the determinism
lives in the fake).

### 6. Docs — the two embeds

In `docs/self-hosting/dorkos-accounts.mdx`, the "Linking from Settings" section
(`:96-114`), add a `<ProductShot>` inside each `<Step>` (no import needed —
`ProductShot` is global):

- After the "Link this instance" step body (`:104`):
  `<ProductShot id="accounts-pending" alt="Settings → DorkOS account showing the 8-character link code and the 'Open dorkos.ai/activate' button, waiting for approval" />`
- After the "Approve, and watch it flip" step body (`:112`):
  `<ProductShot id="accounts-linked" alt="The same Settings panel flipped to Linked — a green dot, the linked account, and 'Last synced just now'" />`

**Sequencing (load-bearing):** the site guard
(`apps/site/.../__tests__/shots.test.ts:113-142`) fails until both shots are in
the **published** `apps/site/public/product/manifest.json` and their
`-light.png`s exist under `apps/site/public/product/`. So the embed edit lands
**after** a real capture+process run publishes the assets and regenerates the
manifest (Phase 4).

### Code structure & file organization

| Change                                                                          | Path                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `initCloudLinkManager` + `getCloudLinkManager`; remove eager singleton          | `apps/server/src/services/core/auth/cloud-link.ts`                                                            |
| Route through `getCloudLinkManager()` (4 sites)                                 | `apps/server/src/routes/cloud.ts`                                                                             |
| Update the module mock (`getCloudLinkManager` instead of `cloudLinkManager`)    | `apps/server/src/routes/__tests__/cloud.test.ts`                                                              |
| Call `initCloudLinkManager(...)` in the gated branch; use accessor at boot/stop | `apps/server/src/index.ts`                                                                                    |
| **[NEW]** fake `FetchLike` factory + guard                                      | `apps/server/src/services/runtimes/test-mode/fake-cloud-link.ts`                                              |
| **[NEW]** fake behavior + guard + import-graph tests                            | `apps/server/src/services/runtimes/test-mode/__tests__/fake-cloud-link.test.ts`                               |
| **[NEW]** seam construction tests (prod-default vs injected)                    | `apps/server/src/services/core/auth/__tests__/cloud-link.test.ts` (extend) or a new `cloud-link-seam.test.ts` |
| Register 2 docs stills; pin both to shard 0                                     | `apps/e2e/capture/shots.ts`                                                                                   |
| Update `SHARD_0_PINNED_SHOTS` assertion                                         | `apps/e2e/capture/__tests__/shots.test.ts`                                                                    |
| `shootCloudLink` drive + call in `captureLightStills`                           | `apps/e2e/capture/surfaces-desktop.ts`                                                                        |
| Two `<ProductShot>` embeds                                                      | `docs/self-hosting/dorkos-accounts.mdx`                                                                       |
| Published assets (from a capture run)                                           | `apps/site/public/product/{accounts-pending,accounts-linked}-light.png` + `manifest.json`                     |

### API changes

None. No route added, removed, or reshaped; no status codes change; the four
`/api/cloud/*` handlers are byte-identical except for resolving the manager
through `getCloudLinkManager()`. No OpenAPI regeneration.

### Data model changes

None. No DB column, no config field. In test mode the fake's issued
`cloud.instanceToken` is written into the **isolated** capture `config.json` (the
real sensitive-field write-through path), and is wiped with `CAPTURE_HOME` on the
next record run.

## User Experience

This ships **no change to what the app does** — the pending→linked flip already
works and already shipped. The user-visible outcome is entirely in the docs:

- **A docs reader on the Accounts page** now sees two real screenshots at the
  "Linking from Settings" steps: the pending state (the 8-character code + "Open
  dorkos.ai/activate" + "Waiting for you to approve…") and the linked state (green
  **Linked**, the account, "Last synced just now"). The prose "Approve, and watch
  it flip" now has the picture that proves it.
- **In the app:** nothing changes. Production still links against the real cloud;
  the seam is a pure refactor of how the manager is constructed.
- **Honesty:** the screenshots show a real UI rendering real (seeded-transport)
  data — the same category as every other capture-pipeline still. The stub fakes
  only the network we cannot reach offline, never a feature that does not work.
  Cloud accounts are a verified surface (not behind the demo-claim gate), so the
  shot is allowed to be documented.

## Testing Strategy

- **Seam construction unit — the keystone honesty proof.** In the cloud-link
  test suite:
  - `initCloudLinkManager()` (no options) then `getCloudLinkManager()` returns a
    `CloudLinkManager`; driving `startLink()` with `globalThis.fetch` spied
    asserts the **real** `fetch` is called — the prod default never injects the
    fake. _Purpose: production construction is behavior-preserving and
    fake-free._
  - `initCloudLinkManager({ fetchImpl: spy })` then `startLink()` calls `spy`,
    proving injection works at the seam. _Purpose: the seam is injectable._
  - `getCloudLinkManager()` **before** `initCloudLinkManager` throws
    `'CloudLinkManager not initialized'`. _Purpose: the guard fails loud, not
    `undefined`._
- **Fake behavior unit (`fake-cloud-link.test.ts`)** — with
  `env.DORKOS_TEST_RUNTIME` stubbed true:
  - `device/code` → 200 with the pinned `user_code`, `verification_uri:
'https://dorkos.ai/activate'`, and the short `interval`. _Purpose: pinned,
    deterministic pending content._
  - `device/token` → `400 authorization_pending` for the first
    `PENDING_POLLS_BEFORE_APPROVAL` calls, then `200 {access_token}` — asserted by
    calling the returned `FetchLike` in sequence. _Purpose: the offline auto-flip,
    deterministically._
  - `device/token` counting is **per `device_code`** — a second code starts its
    own count. _Purpose: relink determinism / no cross-cycle bleed._
  - `heartbeat` → 200 with the pinned `accountLabel` and a fresh ISO `lastSeenAt`.
    _Purpose: the linked view shows the account + "just now"._
  - `revoke` → 200. _Purpose: best-effort no-op covered._
  - an unknown pathname → **throws**. _Purpose: fail loud, never a silent
    escape._
- **Guard unit (`fake-cloud-link.test.ts`):** `createFakeCloudLinkFetch()`
  **throws** when `env.DORKOS_TEST_RUNTIME` is false; returns a `FetchLike` when
  true. _Purpose: the runtime half of unreachability._
- **Import-graph unit:** read the source of `cloud-link.ts`,
  `cloud-link-client.ts`, and `routes/cloud.ts` and assert none reference the
  `fake-cloud-link` module specifier. _Purpose: the structural half of
  unreachability — production never imports the fake — asserted, not assumed._
- **Route wiring (`cloud.test.ts`) — update the mock.** The existing suite mocks
  the `cloud-link.js` module and exports a mock `cloudLinkManager` (`:8-20`); the
  seam changes it to mock `getCloudLinkManager: () => mockManager`. Then its four
  response-shape tests pass unchanged. _Purpose: the routes resolve the manager
  through the seam and still shape responses correctly._
- **Full drive (the e2e).** The capture drive **is** the end-to-end test: a real
  browser opens `?settings=account`, links, and photographs a genuine
  pending→linked flip driven by the real state machine over the fake transport.
  It is exercised by running the capture record path (not added to the Playwright
  test suite; it lives in the capture pipeline). Existing media guards then
  enforce the result: `apps/e2e/capture/__tests__/shots.test.ts` (registry
  invariants, updated pin list) and `apps/site/.../__tests__/shots.test.ts`
  (every embedded id registered + `-light.png` present + `'docs'` consumer).
- **Green gate:** `pnpm --filter @dorkos/server typecheck` +
  `pnpm --filter @dorkos/server lint`; targeted `pnpm vitest run` on the new/edited
  test files; `pnpm --filter @dorkos/e2e typecheck` for the drive. The docs-embed
  guard (`apps/site`) only passes after the capture run publishes the PNGs +
  manifest (Phase 4).

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

Negligible. The seam is one indirection (`getCloudLinkManager()` returns a
module-scoped reference). The fake runs only under `DORKOS_TEST_RUNTIME` and does
no I/O — it resolves canned `Response`s in-process, so the capture flip is bound
only by the server's 1s poll interval and the client's 2500ms status poll (~5s
total). No production path is touched.

## Security Considerations

- **Stronger offline guarantee, not weaker.** Under the stub, the base URL is
  still `https://dorkos.ai`, but **no request reaches it** — the fake intercepts
  before any socket opens. That is the offline guarantee `capturing-product-media`
  requires; today a real `fetch` in the capture stack would escape the sandbox.
- **The fake can never run in production.** Gate (`DORKOS_TEST_RUNTIME`, off in
  prod) + dynamic import (absent from the prod graph) + throwing guard + tests. No
  path lets a shipped instance link against a fake cloud.
- **No new production surface.** The seam is a construction refactor of an
  existing singleton; no new route, auth surface, or external fetch. The
  `cloud.instanceToken` sensitive-field handling and its never-logged contract are
  untouched. The fake token is a constant string, never a real credential.

## Documentation

- **Changelog: NONE — the honest call.** This issue ships **zero product
  behavior change**: the pending→linked flip already works and already shipped;
  the seam is a behavior-preserving refactor invisible to users; the fake is
  test-only; the only user-visible artifact is two screenshots added to an
  existing docs page. The repo's changelog documents **what the product does for
  users** (`writing-changelogs`, AGENTS.md decision filters), and the
  capturing-product-media pipeline routinely refreshes docs media without a
  changelog fragment. The steelman ("new docs images are user-visible → a small
  Added") is rejected: logging a docs-illustration update would set a precedent
  that every screenshot needs a fragment (noise), and the user gains nothing new
  to _do_. Decision: **no fragment.**
- **Docs prose:** unchanged — the existing "Linking from Settings" copy already
  narrates the flip; this only adds the two images.
- **Inline TSDoc** on `initCloudLinkManager`, `getCloudLinkManager`,
  `createFakeCloudLinkFetch`, and the fake's exported constants where non-obvious
  (enforced by `eslint-plugin-jsdoc`).
- **Draft ADR** — seeded in Related ADRs (not created this stage, per the drain
  directive).

## Implementation Phases

The server seam + fake is the bulk and lands first; the capture and docs are
low-risk once the seam exists. The docs embed is gated on a real capture run.

- **Phase 1 — the construction seam:** `initCloudLinkManager` +
  `getCloudLinkManager`; route `routes/cloud.ts` + `index.ts` through the
  accessor; update the `cloud.test.ts` mock; seam construction tests
  (prod-default real `fetch`, injected `fetchImpl`, pre-init guard throws).
- **Phase 2 — the fake + wiring + unreachability:** `fake-cloud-link.ts`
  (four endpoints, pinned constants, per-device-code auto-flip, throwing guard);
  wire it under the `DORKOS_TEST_RUNTIME` branch in `index.ts` (dynamic import);
  fake behavior + guard + import-graph tests.
- **Phase 3 — the capture drive:** register `accounts-pending` +
  `accounts-linked`; pin both to shard 0 and update the pin assertion; add
  `shootCloudLink` + the guarded call in `captureLightStills`.
- **Phase 4 — capture run + docs embeds:** run the capture record+process path to
  produce and publish the two `-light.png`s + the regenerated manifest; add the
  two `<ProductShot>` embeds to `dorkos-accounts.mdx`; confirm the
  `apps/site` docs-embed guard is green.
- **Phase 5 — close-out:** extract the draft ADR (`/adr:from-spec`) and file the
  flip-loop follow-up at DONE.

## Size re-check

Size **3 holds**. Server (the bulk): a small accessor-pair reseat of one
singleton across three files + a scenario-sized fake + the composition-root wire +
four focused test groups — real but bounded, and the injectable seam already
exists (no new class, no config field, no route change). Capture: two registry
entries + one drive + a one-line pin-assertion update. Docs: two component tags.
The design note + capture + docs surface justify not dropping to 2; the absence of
any new infra, config, or production behavior change keeps it from a 5.

## Estimated DECOMPOSE shape

~4-5 tasks along the phase boundaries; Phase 1 (seam) must land before Phase 2
(the fake wires into the seam), and the drive (Phase 3) needs the fake:

1. **Construction seam:** `init/getCloudLinkManager`, route/index/boot through the
   accessor, update the route mock, seam construction tests.
2. **Fake + wiring + unreachability:** `fake-cloud-link.ts`, the gated dynamic
   import in `index.ts`, fake/guard/import-graph tests.
3. **Capture drive:** register the two shots (+ shard pin + pin-assertion update),
   `shootCloudLink`, the guarded `captureLightStills` call.
4. **Capture run + docs embeds:** produce/publish the assets + manifest, add the
   two `<ProductShot>` embeds, confirm the docs-embed guard green.
5. **Close-out:** extract the draft ADR; file the flip-loop follow-up.

(Tasks 1→2→3 are sequential; 4 depends on 3 producing assets. Small enough that
2 and 3 could fold into a single execution once 1 lands.)

## Open Questions

Both the ideation's open question and every SPECIFY-surfaced decision are
resolved; no floor-level blockers remain — direction is fully pinned.

- ~~**Shot shape: two stills, or add the flip loop?**~~ **(RESOLVED.)** Two docs
  stills (`accounts-pending` + `accounts-linked`) for the MVP — simplest, lowest
  timing risk, embeds directly at the two Settings steps. The flip loop is a filed
  follow-up (needs a pending-hold window tuned to the loop length + the client's
  2500ms poll).
- ~~**Seam shape: mutable export or accessor pair?**~~ **(RESOLVED.)** Accessor
  pair (`init/getCloudLinkManager`) with a throwing guard, mirroring
  `get/setWorkspaceManager`; the `configManager` mutable-export pattern is
  rejected (foot-gun, no pre-init guard).
- ~~**Where do the pinned `user_code` / `accountLabel` live?**~~ **(RESOLVED.)** In
  the fake module (server-side), not `apps/e2e/capture/config.ts` (cross-package
  boundary; the drive waits on selectors, not the code value).

## Related ADRs

- **Proposed ADR (extract at close-out via `/adr:from-spec`):** _"Test-mode cloud
  transport: a `DORKOS_TEST_RUNTIME`-gated fake `FetchLike` behind a
  `CloudLinkManager` construction seam."_ Records: the honesty model (fake the
  network dependency only, exactly like `demo-scenarios.ts` fakes the agent
  backend; the real state machine, token persistence, routes, and client run
  unchanged); the construction seam (reseat the eager `cloudLinkManager` singleton
  to an `init/getCloudLinkManager` accessor pair with a throwing guard, mirroring
  `get/setWorkspaceManager`, so the composition root owns construction and
  production `cloud-link.ts` carries zero test branches); the composition-root
  injection under the existing `DORKOS_TEST_RUNTIME` branch via dynamic import
  (mirroring `TestModeRuntime`); and the layered unreachability proof (structural
  dynamic import + runtime throwing guard + prod-default and import-graph tests).
  _(Per the drain directive, this spec seeds the ADR for extraction; it does not
  create the file.)_
- **`specs/accounts-and-auth` / `specs/cloud-account-management`** — the shipped,
  verified device-flow, `cloud.instanceToken` sensitive-field persistence, and the
  pending→linked lifecycle this spec photographs. This work adds a capture seam
  over that behavior and changes none of it.
- **TestModeRuntime / test-control precedent** (`index.ts:440-469`,
  `routes/test-control.ts:11-12,44-50`) — the env-gated, dynamic-import
  composition-root substitution the seam mirrors.

## References

- Issue: **DOR-301** (split from DOR-283). Ideation:
  `specs/capture-cloud-link-stub/01-ideation.md` (the honesty model, the seam
  crux, the four-endpoint contract, the two-stills-vs-loop fork).
- State machine + seam: `apps/server/src/services/core/auth/cloud-link.ts`
  (`startLink` `:179-199`, `runPoll` `:201-233`, `CloudLinkManagerOptions`
  `:122-135`, constructor `:157-165`, eager singleton `:369`, `initOnStartup`
  `:240-247`).
- The `FetchLike` contract: `apps/server/src/services/core/auth/cloud-link-client.ts`
  (`FetchLike` `:40`, `DeviceCodeResponse` `:64-72`, `requestDeviceCode`
  `:128-156`, `pollForToken` `:172-232`, `sendHeartbeat` `:244-285`,
  `revokeInstanceKey` `:300-318`, `resolveCloudBaseUrl` `:94-96`, `defaultFetch`
  `:86`).
- Consumers of the singleton (blast radius): `apps/server/src/routes/cloud.ts:14,22,34,40,50`,
  `apps/server/src/index.ts:26,1430,1479`, `apps/server/src/routes/__tests__/cloud.test.ts:8-20`.
- Composition-root precedent + boot ordering: `apps/server/src/index.ts:169`
  (`start()`), `:440-469` (runtime registration), `:1430` (`initOnStartup`),
  `:1479` (`stop`); `apps/server/src/routes/test-control.ts:11-12,44-50`.
- Honesty template: `apps/server/src/services/runtimes/test-mode/demo-scenarios.ts:7-15`.
- Gate: `apps/server/src/env.ts:90-93` (`DORKOS_TEST_RUNTIME` → boolean).
- Singleton-reseat precedents: `apps/server/src/services/workspace/index.ts:71-82`
  (chosen accessor pair), `apps/server/src/services/core/config-manager.ts:840-846`
  (rejected mutable export).
- Client surfaces + poll: `apps/client/src/layers/features/cloud-link/ui/CloudLinkPanel.tsx`
  (`IdleState` `:126-208`, `PendingState` `:210-246`, `LinkedState` `:248-307`),
  `apps/client/src/layers/features/cloud-link/model/use-cloud-link.ts:25,28,146-149`,
  `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:43`,
  `apps/client/src/layers/shared/model/dialog-search-schema.ts:19`.
- Capture pipeline: `apps/e2e/capture/boot.ts:38-61` (offline env, no
  `DORKOS_CLOUD_URL`), `apps/e2e/capture/shots.ts:47-74,122-131,196-200,215-228`,
  `apps/e2e/capture/surfaces-desktop.ts:560-606` (`captureLightStills`),
  `apps/e2e/capture/lib.ts:77-161` (`shoot`/`attempt`/`attemptShot`/`isShotSkipped`).
- Docs target + guards: `docs/self-hosting/dorkos-accounts.mdx:96-114` (Linking
  from Settings), `apps/e2e/capture/__tests__/shots.test.ts:106-111`,
  `apps/site/src/layers/features/marketing/lib/__tests__/shots.test.ts:106-142`.
