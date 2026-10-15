---
slug: local-playwright-browser
created: 2026-10-14
status: specified
---

# A local browser shared with your agent

**Status:** Draft
**Author:** Codex
**Date:** 2026-10-14

## Overview

Build two local browser modes around pinned Playwright. People and agents operate the same live page. The embedded desktop browser is the default where supported; the npm installation defaults to a separate visible browser window. This document records the superseding human scope of 2026-10-15. Existing-browser support is follow-up DOR-2972, preserved on `codex/existing-browser-follow-up` at recovery commit `70ff4d6250c0e32fa43ad24d7d20c4c4e737b312`. It is not first-shipment acceptance.

## Background / Problem Statement

Current preview shim automation only reaches instrumented framed previews. The old signed-in browser entry starts an isolated headless Playwright MCP process from copied storage state. Neither offers general websites in the same visible page a person uses. Installing the CLI also must not require a separate Playwright installation or unpinned `npx` execution.

## Goals

- Ship exactly **DorkOS browser** and **New browser window**.
- Prove control of the exact embedded WebContentsView through Playwright before expanding implementation.
- Preserve human mouse/keyboard access throughout agent work, with a plain Pause agent control.
- Target explicit session/page identities and reject stale observations before uncertain actions repeat.
- Include pinned Playwright in npm and desktop packages; automatically acquire supported browser executables when necessary.
- Preserve separate DorkOS-owned saved logins across restarts.
- Prove installation and operation from built npm/desktop artifacts without repository dependency resolution.

## Non-Goals

VMs, browser streams, takeover/lease handoff, mobile/cloud execution, existing-browser attachment or consent qualification, personal data copying, extension parity inside Electron, raw Electron/main-process tools, arbitrary shell/debugger tools, or renewed work on the old default-off managed VM programme. This work authorizes no inference spending, credential transfer or account creation. Existing installed DorkOS 0.114.1 and personal browser data are preserved.

## Technical Dependencies

- `playwright-core` **1.63.0**, pinned in runtime packaging and lockfile. Its supported Chromium executable revision comes from that exact package, not a floating Chrome download.
- Electron **41** (currently `^41.10.7`): native `WebContentsView`, sandboxed content, page-scoped `webContents.debugger` transport. Record the resolved Electron version in native proof.
- Existing Hono request chain, Zod schemas, shared `Transport`, client right-panel registry and runtime tool dispatch.
- Official contracts to verify: [Electron support](https://playwright.dev/docs/api/class-electron), [browser attachment](https://playwright.dev/docs/api/class-browsertype), [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view). Current docs are reference material; installed 1.63.0 source decides callable features.

## Detailed Design

### Architecture and ownership

Introduce a local-browser service with a narrow engine port, session/page registry, validated contracts and scoped tools. Keep its resources distinct from old browser VM/streaming registry/custody. A session binds one mode, owner/runtime session, browser identity and selected page identity. Default selection is capability based and recorded, never substituted silently.

The desktop host owns the native view and its persistent Electron partition. The server owns authorization, lifecycle, pause state, operation queue and scoped agent commands. IPC permits view creation, presentation bounds and only the page-scoped automation transport. Agents never receive Electron application evaluation, renderer shell access, raw debugger sessions or a debugging endpoint that exposes the DorkOS shell.

Client presentation uses the panel/resource-tab contract coordinated with its owner. This work must not introduce a competing tab registry. Native view bounds follow panel resize, collapse, route changes, window resize and focus. Hide/remove the native view when its browser resource is not presented, so it cannot cover dialogs, other tabs or shell controls. Parent-window destruction closes owned views and releases transport resources. PiP must use the panel owner's supported native-host contract; no duplicate page or stream is an acceptable substitute. If native content cannot move to PiP, keep it in its supported host and explicitly explain that limit.

### Mode and support matrix

| Surface                                 | DorkOS browser                                   | New browser window       | Default                |
| --------------------------------------- | ------------------------------------------------ | ------------------------ | ---------------------- |
| Local Electron desktop                  | Native view, gated by exact-page proof           | Visible managed Chromium | DorkOS browser         |
| Local npm web app                       | Unsupported native embedding; explanatory choice | Visible managed Chromium | New browser window     |
| Phone, remote client or cloud execution | Outside this MVP                                 | Outside this MVP         | No local-browser claim |

A headed window opens on the computer running DorkOS and needs a graphical desktop. A supported operating-system name alone does not prove that a headless or SSH host can display it.

Capability response includes platform, availability/reason for each mode, supported browser identities and exact dependency versions. Do not claim every desktop platform works because one macOS fixture passed. Windows desktop remains alpha under the repository's existing gate. Linux npm support is claimed only for an actual recorded installed proof; absent platform proof is stated in documentation.

### Embedded browser

First build an isolated fixture with Electron 41 and Playwright 1.63.0. Show a local fixture in a WebContentsView; attach a page-only transport through its debugger; use real Playwright navigation, locators, click and fill; verify the exact visible view changes. A second native page and the shell must remain unreachable. Prove stale-page rejection and transport teardown. The fixture must use no agent model or personal app.

Treat this transport as supported only after the fixture passes. Playwright `_electron` application-level access is not an agent API. If CDP semantics are required internally, limit the emulation/command allowlist to the owned page and its legitimate frame/worker targets, reject browser/root targets and deny target discovery outside that ownership. No unrestricted debugging port. Document lower CDP fidelity and unsupported methods internally.

Embedded browser uses a dedicated persistent Electron partition under DorkOS data. It shares no personal Chrome/Edge data. Do not promise Chrome extensions work inside Electron. Browser content has no Node integration, no shell preload and no DorkOS credential injection. Popups become explicitly registered owned pages or are rejected with a clear recoverable result; they never silently change the active target.

### New browser window

Launch a headed persistent Chromium context with Playwright's exact supported executable and a dedicated DorkOS-owned user-data directory. Do not open the person's usual data directory or clone storage-state files. Reserve directories to prevent concurrent writers. Saved site data survives normal close/reopen. Missing binaries trigger DorkOS-managed acquisition with progress and retry; network refusal, insufficient disk and incompatible platform return actionable states. Cache validity is checked against pinned revision and executable presence. Installation upgrades do not delete saved logins.

Package Playwright's library in both deliverables. Browser acquisition is a separate first-use operation, or a bundled browser if build constraints justify it. No person must run `playwright install` or install Playwright manually. An existing system browser is never silently substituted for the managed executable.

### Existing-browser follow-up

DOR-2972 retains existing-browser attachment and native permission qualification. None of its choices, setup, channel/version fields, public connection paths or consent-proof prerequisites ship here. The recovery branch retains the implementation and proof source; private preserved evidence distinguishes mechanism-only results from native consent acceptance. Personal Chrome remains untouched. The explicit disposable Chrome-only approval applies to that follow-up.

### Contracts, API and tools

Use a versioned Zod-validated contract with mode (`embedded`, `new-window`), sessionId, pageId, page title/URL, connection state, paused flag, observation revision and safe structured error codes. Persist preferences and owned-data metadata; persist no cookie/password values in client preferences or activity records.

Expose authenticated Hono operations for capabilities, create/connect, status/list pages, select page, pause/resume and disconnect/close. Human connection/settings flows retain existing owner and local-host checks. Remote clients must not silently acquire control of a browser on the server computer. Every route uses `readJsonBody` and `honoRequestFacts` through the existing request chain; no separate unauthenticated service.

Agent tools provide scoped page listing/selection, navigation, snapshot, screenshot, click, fill/type, keypress, scrolling and wait/observation as needed. Validate session/page IDs and bounded arguments. Do not expose arbitrary JavaScript evaluation, Playwright code execution, filesystem paths, raw network requests, browser-level debugger commands or Electron evaluation. Internal snapshot extraction may use vetted code; page content never grants authority or overrides tool ownership.

Register the new tools consistently for supported runtimes; coordinate Doc's runtime integration owner. The old npx/headless copied-state browser entry must not shadow these tools or create another page when the new mode is selected. Preserve preview-specific behavior where still applicable, but remove superseded bindings and user guidance rather than leaving two competing browser choices.

### Shared page, pause and uncertainty

No lease or input lock exists between person and agent. Serialize agent mutations per session, leaving native human events untouched. Each observation carries a monotonic revision tied to session generation, selected page and document/navigation state. Snapshot element references bind to that observation. Before dispatch, verify the same page/document and element still exist; reject stale commands before input. Selection, navigation, close, reconnect and changed relevant target state invalidate references. Playwright must not auto-wait into an unrelated later document and perform a stale action there. Keypresses also bind to the focused DOM control captured during observation, following open shadow roots. Changed focus, a removed target, or focus inside a frame or opaque shadow root that cannot be attested is refused before dispatch.

Pause agent stops admission of new mutations and cancels queued ones. It cannot promise an already dispatched click was undone. Record its eventual result, or uncertainty if acknowledgement is lost, and do not replay. Disconnect during an action has the same rule. Timeouts, lost transport, human navigation or page closure after dispatch return an uncertainty result where the effect cannot be known. Resume enables future fresh observations; it never retries a pending effect. Agents must observe again and decide from visible outcome. Log operation identity, action kind, target origin and opaque connection/tab identities, result and uncertainty without sensitive input values. Page titles are shown live, but omitted from durable action records because sites can echo typed values into them.

## User Experience

The entry point names both choices exactly. Each description is a separate copy block:

| Label              | Description                                          |
| ------------------ | ---------------------------------------------------- |
| DorkOS browser     | Browse inside DorkOS with separate saved logins.     |
| New browser window | Open a separate window with saved logins for DorkOS. |

On the web, DorkOS browser explains “Requires the DorkOS desktop app.” It does not create a framed duplicate page. On desktop, unsupported embedded capability explains the limitation and shows the other explicit choices.

The active resource displays the readable browser name, tab title, URL and current agent, so a person knows what is shared. Disconnect ends sharing and closes the owned browser while preserving its saved sign-ins.

Always show **Pause agent**, changing to **Resume agent** when paused. Human interaction remains usable. Recovery copy names a next step: “Browser closed” / “Open it again to reconnect.”; “Page changed” / “Read the page again before continuing.”; “Couldn’t connect” / “Open the browser again and try again.”; “Action result unknown” / “Check the page before trying again.” Library acquisition says “Preparing browser” and gives progress, cancellation and retry. Copy uses calm plain words; no profile, CDP, provider or transport in these flows. Every app block stays at 15 words or fewer.

Native content and controls remain usable at desktop/tablet widths; unsupported mobile local execution is stated honestly. Keyboard focus reaches address/control fields and the live page without traps. Screen readers announce connection, pause and uncertainty state.

## Testing Strategy

- **Unit:** mode/default capability selection; strict schema and page/session ownership; executable revision validation; persistent-directory reservation; pause queue rejection; stale references; uncertainty state after dispatch; reconnect generation invalidation. Tests assert behavior that can fail, not constants echoed from implementation.
- **Integration:** local HTTP fixtures with form counters and navigation prove exactly-once-or-unknown effects, no replay on timeout, page selection isolation, redirects, popups, browser close, reconnect and persistent cookie continuity. Real Playwright backs mutation tests; mocks cover specific crash/network faults only.
- **Native:** isolated Electron fixture proves Playwright controls the exact WebContentsView, normal manual input survives agent action, shell/other page access is denied, view bounds/visibility/focus work and close releases owned resources.
- **Browser E2E:** real client flow for the two labels, truthful web default/unsupported state, named selected page, Pause, disconnect/reconnect and first-use acquisition errors. Follow the browser-testing skill, no model inference.
- **Installed packages:** pack CLI tarball; install into an isolated clean directory; verify it loads included pinned Playwright without workspace node_modules or npx; exercise first acquisition and offline cached reopen, visible persistent window. Pack isolated desktop; run its embedded exact-page and external modes from the packaged app using a separate app-data directory. Record package hashes, versions, executable revision, fixture results and cleanup ownership. Do not alter the installed personal 0.114.1 app.
- **Review:** targeted typecheck/lint/tests, appropriate affected verification and protected CI, independent review, normal hooks/push and protected merge procedure. The proof ledger must distinguish source, isolated dev, package and platform evidence.

Each added test documents its behavioral purpose. Paid inference paths remain unarmed.

## Performance Considerations

Acquire binaries only when needed; reuse validated cached executable/data across launches. Bound snapshot/screenshot sizes, action duration and queue length. One embedded active native view should not keep hidden pages repainting unnecessarily. Avoid retaining unrestricted browser contexts. Cancel owned setup on close and retain persistent data; distinguish cached owned files from foreign resources during cleanup.

## Security Considerations

Scope control to approved browser/page IDs. Preserve the request chain, agent identity and audit conventions. Website text is untrusted input. WebContentsView has sandboxing, context isolation, no Node/shell preload and no administrative IPC. The service never opens personal browser data. Never log cookies, passwords, full filled values or downloaded credential files. Browser access can read the signed-in page; do not claim secrets are invisible. Downloads, uploads and filesystem exposure require existing app policy and explicitly bounded paths, not raw arbitrary access. Cleanup never kills foreign browsers or removes unrelated/unknown-held data.

## Documentation

Update the browser guide with the two choices, platform limits, included library versus automatic browser preparation, saved-logins behavior, owned-browser disconnect, Pause semantics and unknown-action recovery. Update the old signed-in-browser guide/CLI help to avoid conflicting instructions. Add internal engine/transport contract and evidence ledger. Public copy may claim only behaviors and platforms supported by recorded proof. Canonical ADR and spec manifests are maintained by the root owner.

## Implementation Phases

1. **Foundation:** exact embedded feasibility gate, contracts and scoped transport.
2. **Modes:** persistent managed window/acquisition, native embedded lifecycle.
3. **Product:** shared panel presentation, scoped runtime tools, pause/stale/uncertainty behavior and migration.
4. **Delivery:** meaningful real fixtures, installed CLI/desktop proof, docs, independent review, required gates and protected merge.

Both owned modes are required for completion. Existing-browser support and its native consent proof are deferred to DOR-2972 by explicit human direction.

## Open Questions

- ~~(RESOLVED) Should the npm client pretend to embed a native browser?~~ **Answer:** no; New browser window defaults locally, and desktop is required for embedding. **Rationale:** the human explicitly acknowledged the native platform constraint.
- ~~(RESOLVED) Is Playwright a technology decision still under comparison?~~ **Answer:** no, 1.63.0 is pinned. **Rationale:** the human chose Playwright and skipped comparison.
- **Proof gate:** final two-mode installed CLI and packaged desktop artifacts require matching evidence. Historical passed receipts remain historical; native permission is unqualified and belongs to the follow-up.
- **Coordination gate:** panel/PiP presentation and runtime registration must use their owners' current contracts. Record the concrete agreed contract before merging overlapping changes.

## Related ADRs

- `260911-200304`: Browser right-panel presentation and shared document identity; coordinate amendment with the panel owner.
- `260912-025251`: shim-driven instrumented previews; draft local-native amendment must retain applicable preview semantics.
- `261012-211000`: local agent computer is a distinct execution mode, outside this browser MVP.

## References

Human-delegated scope dated 2026-10-14, superseded by the two-mode first-shipment direction on 2026-10-15; old research `research/20261001_shared-browser-control.md` only where applicable; bounded read-only browser handoff outside the repo. Official upstream links are listed under Technical Dependencies. No old unmerged VM/streaming branch is a prerequisite or endorsed base.
