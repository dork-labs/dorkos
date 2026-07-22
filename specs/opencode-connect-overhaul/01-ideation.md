---
id: 260722-184734
slug: opencode-connect-overhaul
tracker: DOR-421
design-session: .dork/visual-companion/43160-1784741753
status: specified
---

# OpenCode connect overhaul — ideation

## Problem (operator report, 2026-07-22)

Connecting OpenCode via the runtime status-bar item fails in three visible ways:

1. After connecting OpenRouter in the modal and closing it, the session still uses Claude Code — the toolbar never shows OpenCode.
2. Reopening the flow does not remember the user already authenticated; it asks again.
3. The model list in the Gateway step is unsorted, and picking a model there feels wrong — model choice belongs in the status-bar model selector.

## Root causes (verified in code)

1. **The readiness probe never reads DorkOS's stored credentials.** Every OpenCode connect path (OpenRouter OAuth/paste-key, Direct provider) persists an encrypted credential reference into DorkOS config (`persistProviderCredential`, `services/runtimes/connect/credentials.ts:179-194`) and sets `runtimes.opencode.provider`. But `checkAuthState` (`services/runtimes/opencode/check-dependencies.ts:100-138`) shells out to `opencode auth list`, which only sees the OpenCode CLI's own `auth.json` — which DorkOS never writes. So `GET /api/system/requirements` reports `state: 'connect'` forever. This single gap causes BOTH bugs 1 and 2: the client's ready-flip (`RuntimeSetupDialog.onRuntimeReady` → `RuntimeItem.onChangeRuntime` → `pendingRuntime`) never fires, so the session never binds to OpenCode; and every fresh probe re-reports "not connected." The gap is flagged, unfixed, in `services/runtimes/opencode/NOTES.md` §4.
2. **The Gateway model `<select>` is decorative** (`OpenRouterGatewayPath.tsx:135-146`): no `value`, no `onChange`; nothing reads it. The shipped spec (`specs/effortless-runtime-switching`) only ever said the dropdown "populates" — a spec gap, not a regression.
3. **No sorting**: `fetchOpenRouterModels` returns OpenRouter's raw API order; neither server nor client sorts.

Session runtime binding itself is working as designed (first-write-wins at first message, ADR-0255); the flow above it starves it of the hint.

## Directions explored (visual companion, 3 screens)

- **A — Connect is setup; model lives in the toolbar.** Modal only connects; success moment; model choice moves to the existing toolbar model selector.
- **B — Power-source picker.** Replace the Local/Gateway/Direct tabs (engineer taxonomy) with one plain-language list of ways to power OpenCode; extensible to future gateways. **Chosen**, composed with A's handoff.
- **C — One brain menu.** Merge runtime + model chips into one menu. Rejected for now: biggest lift, tension with multi-runtime-cockpit positioning.

Refinements chosen in iteration (see `04-design-decisions.md` for the full trail): effort-led cloud headline; trade-off lines in card copy (no compare UI); shared tier vocabulary (Frontier / Solid coder / Quick helper) instead of a capability graphic; local path scope B (installed list + curated shelf + pull-by-name); GPU-honest verdicts on Windows/Linux; no live benchmarking at onboarding (research: no consumer app does this — static memory heuristics + traffic-light labels are the universal pattern).
