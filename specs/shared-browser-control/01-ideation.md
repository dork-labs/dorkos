---
slug: shared-browser-control
number: 261001-190855
created: 2026-10-01
status: ideation
---

# One visible browser for people and agents

**Author:** Codex, with an independent browser architecture debate requested by the operator.
**Flow stage:** IDEATE. **Project:** Canvas and Browser in Rooms. **Tracker:** DOR-2667, captured and claimed by the assigned browser lane.

## 1) Intent & Assumptions

- **Brief:** Review the built-in browser; research Playwright-level keyboard, mouse and automated control, screenshots/seeing the browser, console logs and related capabilities. Consider direct Playwright and Chrome DevTools integration. Debate with a separate agent until alignment on two or three options; present a recommendation for the operator to choose.
- **Assumptions:** Full control should operate the actual visible page. Web, desktop and phone matter. Existing Claude Code, Codex and OpenCode access should keep using the common browser capability surface.
- **Long-term requirements added by the operator:** (1) keep logins and browser state across sessions; (2) start a fresh incognito-like browser without destroying the saved profile, then switch back; (3) each agent has an independent browser that works unattended, with optional viewing; (4) multiple people/agents can share a browser and co-browse/control it; (5) managed browsers do not add Chrome icons to the macOS Dock or app switcher.
- **Out of scope:** Implementing an unselected browser engine, redesigning Doc Channel, building the Touch ID credential broker, replacing lightweight document previews, or granting agents implicit access to personal Chrome tabs.

## 2) Pre-reading Log

- Current Browser iframe, injected capture/driving shim, session browser seat and client bridge: limited preview automation already exists.
- `packages/shared/src/agent-browser.ts`, CLI agent-browser modules and `specs/agent-browser-sessions/`: full headless Playwright MCP and saved sign-ins already exist separately.
- `apps/desktop/src/main/capture/index.ts` and window manager: native app capture exists; current Browser content remains an iframe.
- `specs/canvas-agent-seat/` and ADR `260912-025251`: intentionally rejected an invisible second server rendering.
- Flow IDEATE skill/template and configured Linear adapter: research first, operator choice before SPECIFY.
- [Research and debate record](../../research/20261001_shared-browser-control.md): official documentation, code findings, ticket search and prototype gates.

## 3) Codebase Map

**Current preview flow:** server session tool → selected client/document → iframe shim → correlated result / capture ingest → bounded session evidence buffer.

**Current full-automation flow:** managed MCP preset → isolated headless Playwright context → saved storage state. It does not control the visible preview iframe.

**Potential changes:** server browser lifecycle/authority, client Browser presentation/input, common capability handlers, shared schemas, CLI installation/login compatibility and browser tests. Electron needs native IPC/view work only if option 2 is selected. Doc Channel's document event contract stays a separate concern.

**Agreed package direction (not implemented):** keep this feature in the DorkOS monorepo. A private `packages/browser` (`@dorkos/browser`) owns Playwright integration, profile/process lifecycle and locking, tabs, browser actions, capture and telemetry with an injected data directory. It does not import app code or know DorkOS users, rooms, agent runtimes or HTTP authentication. Server orchestration enforces owner/participant permissions, control leases, session/room bindings, authenticated streaming and shutdown. Shared schemas and Transport methods stay in `packages/shared`; client browser state belongs in an entity and presentation/control in features, composed into existing Browser surfaces. CLI/desktop own distribution/install/update wiring for the browser executable. A package boundary does not imply a separate deployed server or mandatory extra process beyond Chromium.

Blintz is independently consumable as a React editor library; the browser feature currently has no equivalent independent consumer. A separate repository would add coordinated package/app releases while the ownership and protocol design is still changing. Keep the engine interface narrow so later extraction is possible if real outside consumers justify it. Do not create a generic multi-engine framework or a second UI library before the prototype establishes its needs.

Start the standalone prototype under `scripts/browser-control-prototype/` in an isolated worktree, using the existing research gates. After it proves the mechanics, stabilize the engine in `packages/browser` and build the development-only app integration. The final service domain placement, package exports and browser distribution strategy belong in SPECIFY; a new server domain must update the AGENTS service census and its guard test.

## 5) Research

| Option                                                         | Advantage                                                         | Principal trade-off                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **1. DorkOS-owned Chromium + Playwright + shared live stream** | Canonical visible page and robust automation on web/desktop/phone | Remote-input UX, accessibility, browser lifecycle and streaming                        |
| **2. Electron WebContentsView + CDP/native APIs**              | Native embedded desktop browsing with real capture/control        | Desktop dependence; web/phone need streaming and Electron compatibility must be proven |
| **3. Explicit Chrome-tab connection via extension**            | Uses current personal-browser sign-ins and extensions             | Setup and personal-tab authority; weaker DorkOS ownership/sharing                      |

**Recommendation:** option 1, using the Playwright library for normal control, screenshots, snapshots and telemetry, with CDP for proven gaps. DorkOS owns tab/context lifecycle and human takeover. Reuse login/storage state and consider upstream MCP tools as an optional scoped facade, not the default owner.

The five additional requirements strengthen option 1 but change persistence: the current isolated MCP preset seeds a saved login snapshot and does not write agent changes back. Use named persistent profiles for durable browsing and separate ephemeral contexts for clean mode. A profile, a running browser, a tab and a viewer are distinct objects; closing a viewer must not close the browser. Co-browsing shares one running tab, with authorized participants and serialized control, rather than launching two browser processes against one profile directory. See the research report's long-term fit assessment.

Extending the existing shim alone cannot meet full-browser control: it stays valuable for lightweight previews but cannot cross framing restrictions or supply browser-level input and capture. Chrome DevTools MCP is a diagnostics candidate within the selected architecture, not a replacement for shared presentation and ownership.

The independent agent challenged stream UX, MCP ownership, personal browser authority and the existing ADR. Both agents aligned on the three-option ranking after resolving those challenges. The full record and primary sources are in the linked research report.

## 6) Decisions

**Resolved:** perform Flow IDEATE research and separate-agent debate; reuse current capabilities and sign-in work; keep this scope separate from Doc Channel.

**Operator agreement:** the operator accepted the managed Playwright direction and monorepo package boundary on 2026-10-01 (“All of this sounds good”). Proceed with the bounded prototype and evidence-refined production delivery; authorized PR/merge/DONE scope is recorded in `00-run-assumptions.md`. Production contracts remain to be specified and validated; no accepted ADR has been changed.

**Next stage:** SPECIFY the managed Playwright prototype and its acceptance gates, then refine the production approach from its findings, including a prototype for exact page identity, input/IME/touch/clipboard, accessibility, takeover, logs/screenshots/popups, tunnel latency, installation/recovery and owner-qualified room sharing. Amend ADR `260912-025251` explicitly if the selected approach changes it. Then DECOMPOSE through Flow.

The prototype must also prove profile restart persistence, clean-mode isolation and return, two independently running agents with no viewer, multi-viewer/control handoff, and no Chrome Dock/app-switcher presence on the pinned macOS browser build. Site-driven expiry and reauthentication remain possible even with a persistent profile. Use an isolated test identity and profile, not the operator's email credentials.

**Tracker evidence:** completed DOR-213, DOR-2004/2007/2009 and DOR-2155 cover related shipped work; open DOR-2156 is a sign-in broker and DOR-2662 is a preview bridge trust issue. No exact open visible-browser unification ticket was found in the team-scoped snapshot search. Create/triage a separate issue when the pending tracker batch is authorized.
