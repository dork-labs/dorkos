# Task Decomposition — capture-cloud-link-stub

**Spec:** `specs/capture-cloud-link-stub/02-specification.md`
**Tracker:** DOR-301
**Mode:** full
**Generated:** 2026-07-17T19:44:26Z

5 tasks across 5 sequential phases. No parallelism — each phase's server/capture
state gates the next (the seam must exist before the fake can wire into it; the
fake must be wired before the drive can safely click "Link this instance" inside
the sandbox; the drive must exist before a capture run can publish assets; the
assets must be published before the close-out documents the shipped surface).

## Critical path

```
1.1 (seam) → 2.1 (fake + wiring) → 3.1 (capture drive) → 4.1 (capture run + docs) → 5.1 (close-out)
```

No task is promotable to a tracker sub-issue (`isPromotableToSubIssue` requires
`size >= xl`; the largest tasks here are `md`).

## Phase 1 — The construction seam (accessor pair)

### Task 1.1: Reseat cloudLinkManager to init/getCloudLinkManager, route routes/cloud.ts (4 sites) + index.ts (import/boot/stop) through the accessor, update the cloud.test.ts mock, seam construction unit tests

- **Size:** md · **Priority:** high · **Dependencies:** none

Replace the eager `export const cloudLinkManager = new CloudLinkManager()`
singleton (`cloud-link.ts:369`) with an accessor pair —
`initCloudLinkManager(options?)` / `getCloudLinkManager()` (throws if read
pre-init) — mirroring the `get/setWorkspaceManager` precedent. Route the four
`routes/cloud.ts` call sites and `index.ts`'s boot (`initOnStartup`) / stop /
runtime-registration block through the accessor. `index.ts` calls
`initCloudLinkManager()` (no options) in **both** branches of the
`DORKOS_TEST_RUNTIME` conditional for now — task 2.1 swaps the true-branch call
for the fake-injected version. Update `cloud.test.ts`'s module mock to export
`getCloudLinkManager` instead of the value `cloudLinkManager`. Add 3 seam
construction unit tests: prod-default construction uses real `fetch`, injected
`fetchImpl` works, pre-init `getCloudLinkManager()` throws.

This is the keystone task — every other task assumes the accessor exists.

## Phase 2 — The fake FetchLike + composition-root wiring + unreachability

### Task 2.1: Add createFakeCloudLinkFetch() (four scripted endpoints, pinned constants, per-device-code auto-flip, throwing guard) at fake-cloud-link.ts, wire it via gated dynamic import in index.ts, fake behavior + guard + import-graph tests

- **Size:** md · **Priority:** high · **Dependencies:** 1.1

New module `services/runtimes/test-mode/fake-cloud-link.ts`, sibling to
`demo-scenarios.ts`. Scripts the four device-flow endpoints
(`device/code`, `device/token`, `heartbeat`, `revoke`) with pinned deterministic
constants (`DORK-2F7Q` user code, `Dork Labs` account label, etc.) and a
per-`device_code` poll counter that auto-flips to `approved` after
`PENDING_POLLS_BEFORE_APPROVAL` (2) pending responses. Guarded by the validated
`env.DORKOS_TEST_RUNTIME` boolean (throws if false). Wired into `index.ts`'s
existing `DORKOS_TEST_RUNTIME` branch via a gated dynamic `import()`, replacing
task 1.1's interim `initCloudLinkManager()` call with
`initCloudLinkManager({ fetchImpl: createFakeCloudLinkFetch() })`. 9 new tests:
6 fake-behavior cases, 2 guard cases, 1 import-graph assertion (production
auth modules never reference `'fake-cloud-link'`).

## Phase 3 — The capture drive (shots + shard pin)

### Task 3.1: Register accounts-pending + accounts-linked (pinned to SHARD_0_PINNED_SHOTS), update the shots.test.ts pin-equality assertion, add the shootCloudLink drive and its guarded call at the end of captureLightStills

- **Size:** sm · **Priority:** high · **Dependencies:** 2.1

Register two `consumers: ['docs']` stills in `shots.ts`, both pinned to
`SHARD_0_PINNED_SHOTS` (a single linear device flow must not split across
shards). Update the `shots.test.ts` pin-equality assertion. Add the
`shootCloudLink` drive to `surfaces-desktop.ts`: opens `?settings=account`,
clicks **Link this instance**, shoots `accounts-pending` on the optimistic
pending render, waits for the fake's auto-flip, shoots `accounts-linked`. Called
guarded (`isShotSkipped`) at the very end of `captureLightStills` so the linked
token doesn't bleed into earlier shots. No changes to `config.ts` — the pinned
values live in the fake (task 2.1), not the capture harness.

Depends on 2.1: the capture stack always runs with `DORKOS_TEST_RUNTIME=true`,
so without the fake wired, "Link this instance" would attempt a live fetch to
`dorkos.ai` inside the sandbox.

## Phase 4 — Capture run + docs embeds

### Task 4.1: Run capture record+process to publish accounts-pending/accounts-linked + the manifest, embed both via <ProductShot> in the two "Linking from Settings" Steps of dorkos-accounts.mdx, confirm the site docs-embed guard is green

- **Size:** sm · **Priority:** high · **Dependencies:** 3.1

Run `pnpm --filter @dorkos/e2e capture:record` then `capture:process` (or the
combined `capture` script) to produce and publish
`accounts-{pending,linked}-light.png` + the regenerated manifest. Embed
`<ProductShot id="accounts-pending" .../>` and
`<ProductShot id="accounts-linked" .../>` at the two "Linking from Settings"
`<Step>`s in `docs/self-hosting/dorkos-accounts.mdx`. Confirm the site's
docs-embed guard test (`apps/site/.../shots.test.ts`) passes — it only goes
green once the assets and manifest exist, which is why this task is sequenced
after 3.1 rather than alongside it.

## Phase 5 — Close-out (draft ADR + follow-up pointer)

### Task 5.1: Extract the draft ADR via /adr:from-spec (accessor seam + fake honesty model + layered unreachability), record the flip-loop follow-up pointer for DONE — no changelog fragment (justified: zero product behavior change)

- **Size:** sm · **Priority:** medium · **Dependencies:** 2.1, 4.1

Extract a `proposed` ADR (via `/adr:from-spec`) capturing: the honesty model
(fakes only the network dependency), the construction seam (accessor pair over
mutable export), the composition-root injection pattern, the three layered
unreachability defenses, and the two-stills-for-MVP scope call. Record the
flip-loop follow-up (deferred per SPECIFY's resolved Open Q1) in a labeled spot
for DONE to pick up — not filed as a tracker issue here; that's DONE's job.
**No changelog fragment**: this ships zero product behavior change (the flip
already worked; the seam is invisible to users; the only user-visible artifact
is two docs screenshots) — the spec's Documentation section explicitly rejects
the "new docs images are user-visible" steelman.

## Next stage

EXECUTE: `/flow:execute specs/capture-cloud-link-stub/02-specification.md`
