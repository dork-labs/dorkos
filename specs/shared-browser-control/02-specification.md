---
slug: shared-browser-control
number: 261001-190855
created: 2026-10-01
status: specified
---

# Managed browser mechanical prototype

**Status:** Approved bounded experiment — production refinement follows measured evidence.
**Author:** Codex
**Date:** 2026-10-01

## Overview

Build a bounded local experiment in `scripts/browser-control-prototype/` to test one actual Chromium page controlled by scripted workers and optionally viewed by people. Retain reproducible scripts and an evidence report; evolve only proven mechanics into the production engine. The full production deliverable remains all five requirements in `01-ideation.md`.

## Background / Problem Statement

The existing visible Browser is an iframe driven by a page shim. Full Playwright MCP automation owns another isolated browser seeded from saved storage state. These have different page state and lifetime. Named persistent browser identity and optional shared viewing need a server-owned canonical page rather than another rendering of its URL.

## Goals

- Measure durable profile restart, clean state isolation and return.
- Prove two independent workers run with zero viewer subscriptions.
- Prove two viewers see the exact controlled tab, including navigation and popups.
- Exercise serialized control, explicit handoff and immediate human takeover with stale action rejection.
- Measure mouse, keyboard, text composition, clipboard, touch, accessibility, latency, executable and crash behavior.
- Prove macOS no-icon/no-focus behavior on the exact pinned executable rather than infer it from a headless flag.

## Non-Goals

Personal Chrome access, Touch ID credential broker, paid model turns, real account authentication, general-purpose public CDP, production auth, and claims of universal website compatibility. The prototype does not change Doc Channel or replace lightweight previews. Production refinement must explicitly preserve iframe-based Doc Channel previews or specify a browser-process transport; pixel viewers are not SDK iframe parents. Require independent emit/downstream replay with zero viewers, no duplicate emission with two viewers, and old-page transport revocation on navigation without forcing documents through managed Chromium.

## Technical Dependencies

Use the repository's lockfile-resolved Playwright 1.63.0 resolved by `apps/e2e`. Record the resolved library version, Chromium revision, executable path, SHA-256 and OS in every evidence receipt. Use public Playwright APIs for actions and capture; use CDP only where a measured gap needs it. Consult official API source/docs before freezing code around version-sensitive APIs.

## Detailed Design

### Objects and lifetime

A profile names durable state; one persistent context owns its directory exclusively. A browser is a running context/process; a tab is a stable page identity; a viewer is a disposable subscription; a controller holds a revocable epoch. Never open one profile directory from two processes. Closing every viewer leaves browser work running. Clean mode uses a new context with no storage-state seed and disposable storage, with the durable context retained or reopenable.

### Experiment layout

- `fixture` serves a loopback fake authenticated application with login cookie, localStorage, IndexedDB, counter, form/composition field, draggable target, scroll region, popup, failing request and console/error cases. Login uses a fictitious identity.
- `manager` launches actual headless Chromium, assigns stable tab IDs, holds a process-safe profile reservation, and owns shutdown independently of subscribers.
- `viewer` renders actual page capture plus identity metadata. It sends bounded pointer/key/text actions to the same Page, never loads the target URL into an iframe.
- `control` authorizes only server-token-bound fixture participants, serializes composite actions and checks epoch immediately before dispatch. Takeover invalidates queued prior-epoch work. Already-dispatched operations need an explicit abort/barrier result; do not claim they can be undone. Unstarted composite steps must recheck the epoch and stop. Before granting the next controller input, manager-owned reset releases held mouse buttons/modifiers and cancels composition; takeover and disconnect must not strand a drag or modified key. Bound an in-flight barrier to 2 seconds, then report failure rather than hold human input indefinitely.
- `runner` drives deterministic gates and writes screenshots, structured logs and a receipt under an ignored temporary directory. No cookies, profile files or credential contents enter logs or commits.

Capture uses latest-frame backpressure with one pending frame per viewer and monotonic capture sequence. Tab ID, navigation generation, viewport dimensions and control epoch accompany evidence. Viewport is canonical for the tab; mounting or resizing a viewer does not silently resize the browser.

No public raw CDP listener is created. Viewer requests are loopback-only and protected by an unpredictable fixture session token; same-origin and explicit allowed-origin checks reject cross-site input. Token A cannot submit actions or control requests as participant B; participant identity is never selected by request body. The fixture must not access the real DorkOS server, personal profile directories or external authenticated sites.

## User Experience

The local viewer shows the fixture tab identity, current controller and connection state. A viewer explicitly requests control; a second participant can watch, receive a handoff or take human control. Disconnection removes only that view. Clean mode is visible and returning to the named profile restores its saved fixture identity. Failures show whether the browser stopped, input was refused, or a frame is stale.

## Testing Strategy

Each gate has observable subjects and negative controls. A missing executable or missing UI observation is an unverified gate, not a skip counted as success.

| Gate              | Required evidence and target                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable identity  | Login cookie, localStorage and IndexedDB survive three graceful process restarts; clean mode contains none; returning to profile restores all three. Session-only state is recorded separately. Seed service-worker, Cache Storage and HTTP-cache fixture state; clean mode sees none, and return preserves the durable values.                                                                                           |
| Profile exclusion | Two simultaneous open attempts for one profile yield exactly one holder; the rejected process cannot mutate files; clean shutdown releases reservation. Kill the manager while holding it; recover a stale reservation while refusing to steal a live holder.                                                                                                                                                             |
| Unattended work   | Exactly two workers on distinct contexts each reach their known final counter while viewer count remains zero; reopen shows those final values. Also attach two viewers mid-work, close both, then require exact remaining mutations and the same tab identity on reopening.                                                                                                                                              |
| Exact tab         | Frame and action receipts have matching stable tab/navigation IDs; counter changes appear in both viewers; popup gets a distinct tab ID and never silently replaces the action target. Distinct visible tab markers and known action revisions must appear in captured pixels; wrong-page capture is a failing negative control.                                                                                          |
| Handoff           | At least 100 controlled action/handoff rounds; zero post-revocation queued actions execute. Human takeover acknowledgement p95 under 100ms locally, measure first accepted human input too, with maximum 2-second barrier. Test blocked and composite operations; unstarted steps cease. Hold a mouse button/modifier/composition, revoke its queued release, and prove the first human action is unmodified after reset. |
| Frame freshness   | At 1280×720, local input-to-observed-frame p95 under 250ms over 100 samples; under injected 150ms RTT, p95 under 600ms. Measure through real viewer decode/render with changed revision visible, not server capture timestamps. Report bandwidth, encoding cost and dropped frames. Injected RTT is not evidence of actual tunnel performance.                                                                            |
| Slow viewer       | One deliberately stalled viewer cannot increase the other viewer's frame age beyond target or produce an unbounded queue. Stall for 10 seconds; at most one pending frame and 2 MiB per viewer, with oversize frames refused.                                                                                                                                                                                             |
| Input             | Coordinate click/drag/wheel, modifier chords, emoji, CJK composition, paste/copy and touch scroll preserve exact fixture output; stale viewport coordinates are refused. Test phone-sized viewer separately. Record native IME, clipboard permission denial and physical phone touch separately from synthetic events; unobserved native cases are unverified. Actual phone evidence gates production readiness.          |
| Accessibility     | Viewer chrome is keyboard reachable with names and focus; inspect page semantic snapshot. A pixel stream alone does not satisfy screen-reader page browsing: document a viable semantic interaction design or fail the production readiness gate.                                                                                                                                                                         |
| Diagnostics       | Known console/error/network failures are attributed to correct tab and navigation; bounded buffers expose loss counts; reconnect and popup evidence remain attributable.                                                                                                                                                                                                                                                  |
| macOS presence    | Compare Dock/app-switcher inventory and foreground app before launch, during capture/input and after crash/recovery. Positive control proves inventory can detect a visible test app. Zero managed Chromium icons/focus steals in normal headless operation.                                                                                                                                                              |
| Crash/install     | Record cold install/start, absent executable, forced process death, relaunch, profile integrity and graceful shutdown; no orphan process remains. No silent download during an action.                                                                                                                                                                                                                                    |
| Resources         | Measure idle/active CPU, RSS and frame bandwidth for two browsers/two viewers. Record observed values and derive production caps; do not invent a passing resource threshold without host baseline.                                                                                                                                                                                                                       |

IME, clipboard and touch must cross real viewer event handlers, not only call Playwright APIs. Automated text insertion is insufficient proof of IME behavior. Accessibility and macOS evidence require actual surface observation. Actual tunnel measurement requires an authorized fixture-only route and cannot reuse operator accounts.

## Performance Considerations

Stream only while subscribed. Bound frame queue, telemetry, action payload and action duration. Record measurement distributions and host load. Browser process RSS is measured separately from Node and viewer. Persistent profiles may require a process per profile; measure before setting production concurrency limits.

## Security Considerations

The prototype is a loopback experiment, not production authorization. Profile storage is private, never exported through viewer URLs. Fixture participants are explicit and actions fail closed for absent identity, stale epoch, wrong tab or navigation generation. Browser contexts are state isolation, not an OS sandbox. Production needs host/network confinement, per-owner participant grants, artifact policy and explicit signed-in-account sharing disclosure.

## Documentation

Write reproducible commands, executable receipt and per-gate findings in `05-prototype-evidence.md`. Retain failed gates and limitations. Each gate receipt records pass/fail/unverified, subject IDs, sample count, baseline and negative-control outcomes, command, timings, artifact paths and limitations. Refine `02-specification.md` only after evidence; it must cover package/server/Transport/client/CLI/desktop placement, distribution, ACLs, resource limits and recovery.

## Implementation Phases

1. Freeze this bounded experiment, decompose canonical tasks, and claim within live WIP budget.
2. Implement fake site, real Chromium lifecycle, controlled workers and optional viewers.
3. Run mechanical and observed-surface gates; independently review evidence and implementation.
4. Refine production specification, explicitly amend ADR 260912-025251, and decompose engine then app delivery. Prototype success never closes the full production parent.

## Open Questions

- ~~(RESOLVED) Engine location~~ Answer: private `packages/browser` in this monorepo. Rationale: no independent external consumer; server authority stays in the app.
- ~~(RESOLVED) Canonical rendering~~ Answer: one owned Chromium Page with optional actual-page capture. Rationale: preserve accepted ADR's same-visible-state requirement.
- Prototype findings remain open: semantic remote accessibility, native composition/clipboard fidelity, actual tunnel latency, pinned macOS executable behavior and observed resource caps. These are experiment outcomes, not product choices to defer out of core scope.

## Related ADRs

[260912-025251](../../decisions/260912-025251-browser-driving-rides-the-in-page-shim.md) needs an explicit amendment before production shared browser implementation. The prototype does not mark it superseded.

## References

[Ideation](01-ideation.md), [research](../../research/20261001_shared-browser-control.md), [run assumptions](00-run-assumptions.md). Existing signed-in browser work and Touch ID broker stay separate; fresh tracker snapshot is authoritative over old research state.
