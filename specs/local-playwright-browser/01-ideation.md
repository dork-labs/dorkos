---
slug: local-playwright-browser
created: 2026-10-14
status: ideation
---

# A local browser shared with your agent

**Author:** Codex
**Date:** 2026-10-14

## 1) Intent & Assumptions

- **Task brief:** First shipment, as superseded by the human on 2026-10-15, delivers exactly two modes: **DorkOS browser**, a real browser inside the desktop app's right panel; **New browser window**, a visible Chrome/Chromium window with separate saved logins owned by DorkOS. Existing-browser support is deferred to DOR-2972, preserved in recovery commit `70ff4d6250c0e32fa43ad24d7d20c4c4e737b312` on `codex/existing-browser-follow-up`. Include Playwright in the desktop and npm installations. The person and agent use the same live page; human mouse and keyboard remain usable.
- **Assumptions:** Local desktop gets the embedded mode by default where proven; local npm gets New browser window by default. Selection is explicit and capability based. Browser downloads are managed by DorkOS when required, distinct from installing the library.
- **Out of scope:** VM, streaming, mandatory takeover or lease handoff, cloud/mobile browser execution, new inference, account creation, copying personal sign-ins, arbitrary Electron administration, upgrading or quitting the person's installed DorkOS app without coordination. The old Managed Browser programme and paused Community work are not resumed.

## 2) Pre-reading Log

- `AGENTS.md`, `meta/VISION.md`, `meta/PRINCIPLES.md`, `meta/VOICE.md`, `meta/ROADMAP.md`: founders first; plain copy; claim only measured working behavior. The latest human-supplied AGENTS instructions govern trust state.
- Flow ideation/specification/decomposition templates and skills: full specification, self-contained tasks, evidence gate.
- `packages/browser/package.json`: existing private package pins `playwright-core` 1.63.0; a dependency alone does not prove installed operation.
- `apps/desktop/package.json`: Electron 41 series, currently `^41.10.7`.
- `packages/shared/src/agent-browser.ts`: old managed entry runs `npx @playwright/mcp@0.0.82`, headless and isolated from a copied storage-state file. It cannot satisfy the same-live-page or included-library requirements.
- ADR `260911-200304`: existing browser presentation belongs to the right panel, with shared document identity.
- ADR `260912-025251`: in-page shim controls instrumented previews. This remains relevant to previews; this new scope needs a deliberate amendment for native pages.
- Old research and handoff are bounded source material only. They are not an accepted implementation base or permission to restart the old programme.

## 3) Codebase Map

- `packages/browser`: existing private engine/lifecycle contracts; isolate new local Playwright implementation from old VM/streaming custody.
- `packages/shared/src/browser-*.ts`, `transport.ts`: validated browser contracts and transport boundary.
- `apps/server/src/services/browser`, `services/session/browser-seat`: browser ownership and tool dispatch; Hono routes enter the existing request chain.
- `apps/desktop/src/main`, `src/preload`: native browser view, bounds and page-scoped transport.
- `apps/client/src/layers/features/right-panel`: presentation registry and shared panel behavior, coordinated with the panel/PiP owner.
- `packages/cli`: published library/executable acquisition and installed proof.
- Data flow: agent or person chooses a mode → server-owned session/page registry → selected native page → live status/URL/title in the panel. Commands return to that exact page with a fresh revision.
- Blast radius: desktop, server, shared contracts, client panel, CLI packaging, runtime tool registration, browser docs and existing browser-session migration.

## 5) Research

The human chose Playwright; no further comparison study is needed. The early gate is direct Playwright control of the **exact** Electron WebContentsView shown to a person. A page-only debugger transport is the candidate, with Playwright 1.63.0 and Electron 41. Official Electron support is experimental, while CDP attachment has lower fidelity than Playwright's native protocol. A fixture must prove navigation, snapshot, normal click/fill and simultaneous human input before implementing around it. Neither synthetic shim clicks nor automation of another Chrome page count.

The npm web client cannot embed an arbitrary native browser rendering surface. It must truthfully offer the visible external window, with embedded mode explained as requiring the desktop app. A framed duplicate page is not a fallback.

For a separate window, DorkOS acquires the exact Playwright-supported Chromium build automatically and keeps persistent data in its own directory. Existing-browser attachment and native permission qualification belong to DOR-2972, outside first-shipment acceptance.

## 6) Decisions

| Decision              | Choice                                          | Rationale                                                     |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Browser engine        | Playwright 1.63.0                               | Human chose it; package already pins it.                      |
| Embedded presentation | Native Electron WebContentsView                 | Same real page, no stream or duplicate frame.                 |
| Web default           | New browser window                              | Honest local npm support without a native view.               |
| External saved logins | Persistent DorkOS-owned data                    | No personal data sharing or copying.                          |
| Human input           | Always available; Pause agent                   | No ownership lease or takeover ritual.                        |
| Uncertain effects     | Stop, observe again, never replay automatically | Timeout or navigation does not prove no side effect occurred. |
| Next step             | Specify and execute gated feasibility first     | The request is already precise.                               |
