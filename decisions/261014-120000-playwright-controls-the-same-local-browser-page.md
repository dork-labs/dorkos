---
id: 261014-120000
title: Playwright controls the same local browser page
status: accepted
created: 2026-10-14
spec: local-playwright-browser
extractedFrom: local-playwright-browser
superseded-by: null
amends: 260912-025251
---

# 261014-120000. Playwright controls the same local browser page

## Status

Accepted. This amends ADR260912-025251 for the local Browser panel: its restriction against server-side browser control still governs instrumented previews, while the two local native browser modes use Playwright on the same live page. Installed CLI and packaged desktop behavior is qualified on macOS; Windows and Linux qualification remains pending.

## Context

The human chose Playwright for local browser control. On 2026-10-15 the human narrowed the first shipment to an embedded desktop page and a separate visible browser with DorkOS-owned saved logins. Existing-browser support is a separate follow-up, DOR-2972; recovery commit `70ff4d6250c0e32fa43ad24d7d20c4c4e737b312` on `codex/existing-browser-follow-up` preserves its implementation and proof source. Native connection permission is not qualified. Current shim driving is limited to instrumented previews, while the copied-storage headless MCP path renders another page. The npm web app cannot embed an arbitrary native browser without a stream, and this scope explicitly excludes streaming and VMs.

## Decision

Use pinned Playwright 1.63.0 against the exact live native page. The embedded page uses Electron 41.10.7 WebContentsView plus a private page-only debugger transport, verified by the real-Playwright bridge fixture and packaged native-page proof; it exposes no Electron shell/application authority. Desktop defaults to the embedded mode where supported; local npm defaults to a separate visible persistent managed Chromium window with automatic pinned executable acquisition. Human input remains live; Pause blocks future agent mutations and stale/unknown effects stop without automatic replay.

This amends ADR260912-025251 for these local native browser modes. Its instrumented-preview shim remains applicable to previews; neither preview shims nor duplicated pages count as native-browser proof. This is separate from the old Managed Browser VM programme and the local agent computer.

## Native transport contract

The guest owns a sandboxed `WebContentsView`, separate persistent partition, and no
Node access or shell preload. The private bridge authenticates every HTTP/WebSocket
request and exposes exactly one guest target. Root commands allow version metadata
and that guest's attachment only. Browser administration, storage commands, foreign
sessions, target creation/disposal/discovery, and shell targets are refused.
Genuine page/frame/worker commands required by Playwright remain available inside
that guest. This does not promise full browser-level CDP fidelity.

The attachment preserves native bounds with `noDefaults:true`. That option also
skips Playwright's ordinary focus emulation. Electron suspends compositor frames for
an initially hidden view, and initial emulation alone stops being reliable after
navigation. The transport initializes Chromium's supported focus control and renews
it after each main navigation, serializing page commands behind that reset. Closure
removes listeners and prevents pending resets from enabling a closed page. This is
real Chromium rendering of the same page, with no streamed or duplicate surface.
Production macOS proof covers delayed reloads and cross-site renderer process swaps;
Windows remains unverified.

## Consequences

### Positive

- A person and agent see and act on one live page, with explicit browser/tab identity.
- Separate saved logins persist without accessing personal browser data.
- Library packaging and browser acquisition are independently verified from installed artifacts.
- Scoped page transport prevents browser tools from gaining Electron administrative access.

### Negative

- Embedded rendering is desktop-only and requires native lifecycle/bounds handling.
- Electron support is experimental upstream; page-only CDP behavior needs version-pinned real fixtures.
- A new browser window requires a graphical desktop on the computer running DorkOS; headless hosts cannot provide it.
- Human navigation can invalidate observations, and interrupted effects may remain unknown rather than retryable.
