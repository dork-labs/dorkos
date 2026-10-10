# Session routing and identity tasks

Canonical task data: `03-tasks.json`. Tasks 1.1–3.2 passed focused verification and independent Stage 1 review. Task 4.1 remains in progress until final browser, repository and branch review gates pass.

### Task 1.1: [session-routing-identity] [P1] Resolve unknown session ownership through native discovery

Add optional AgentRuntime.findSession(sessionId): Promise<Session|null> in packages/shared and implement registry resolution that honors durable first-write-wins runtime bindings, otherwise probes registered runtimes without cwd. A matching Session supplies actual directory. Reject ambiguity and unavailable bound runtime, never assume default Claude ownership for a verified external Codex/OpenCode identity. Boundary-check before persisting a discovered binding. Details, history, tasks, SSE, WebSocket, limits/continuation and existing-message submission share resolution. Tests cover durable/alias ownership, unknown/ambiguous ids, native cwd outside boundary, outages, and no runtime creation or billed send during lookup.

Dependencies: none

### Task 1.2: [session-routing-identity] [P1] Discover and read native sessions for all runtimes

Implement read-only findSession for Claude Code JSONL across configured account/project stores, Codex native homes using thread/list and thread/read or supported native-store reader, and OpenCode managed-sidecar native sessions with ses_* aliases. Codex external history must render before a DorkOS event log exists and must not duplicate native events on later continuation. Accessible desktop native threads are included; regular ChatGPT chats, inaccessible cloud tasks and unrelated sidecars are unsupported. Use realistic native-store fixtures with no DorkOS metadata row, verify nonempty history, restart reload and no create/resume/send calls.

Dependencies: 1.1

### Task 1.3: [session-routing-identity] [P1] Preserve optimistic creation and pre-message settings

Keep an explicit draft lifecycle across all runtimes: reserve optimistic IDs, subscribe before native creation, retain model/permissions/inference source before first message, populate cwd when first creation follows settings, bind native identity exactly once. An unknown existing session is an error, never an implicit draft. Preserve the earlier persisted-directory read fallback. Regression tests for draft404, first send, settings then send, restart and existing established directory staying authoritative.

Dependencies: 1.1

### Task 2.1: [session-routing-identity] [P2] Hydrate session state without directory query parameters

Change existing-session loader to fetch ID-only metadata and hydrate directory/runtime state and cache keys without redirecting to dir. Gate detail/history/stream/composer on resolved identity; a stale global selected directory never redirects an existing conversation. Canonicalize legacy dir/agentPath links to opaque session links after successful resolution. Explicit new-agent launch resolves agentId on server; unregistered launch directory uses opaque server-owned workspace/launch reference, with browser history state permitted only for nonportable transient draft navigation. Preserve message/panel/search and explicit draft IDs. Tests cover reload, paste, stale cwd,404existing vs draft,503 and no private paths in copied links.

Dependencies: 1.1, 1.3

### Task 2.2: [session-routing-identity] [P2] Centralize all typed client navigation and shared hrefs

Extend current sessionPath/toSession/sessionHref helpers into one shared typed routefactory barrel for all static destinations, room/thread, marketplace sources and extension links. Use TanStack checked linkOptions for navigation and pure shared href builders for server/desktop. Separate existing session(sessionId) from new-session agent/workspace launch factories. Migrate all caller hardcodes and preserve search merging, root dialogs, legacy relay/session redirects and extension strings. Factory fixtures cover optional safe view search, encoding and no dir/agentPath in canonical existing links.

Dependencies: none

### Task 2.3: [session-routing-identity] [P2] Enforce factory usage with an AST lint rule

Add AST-aware ESLint rule for internal Link/href and navigate/redirect destination literals; include aliases and inline query strings. Exempt only route declarations, actual factories, external/API URLs, focused test fixtures and extension author contracts. Migrate every violation; no broad app exemption. Retain server/desktop session-link boundary coverage. Meaningful rule tests catch actual hardcodes and avoid false positives on ordinary prose, APIs and external links.

Dependencies: 2.2

### Task 3.1: [session-routing-identity] [P3] Generate thin route modules in web and desktop

Replace createRoute/addChildren tree in apps/client/src/router.tsx with app-root routes modules and generated tree. Preserve root context/onboarding search, pathless _shell/_home layouts, shared dialogs, staticData.header, custom search parser and stringifier, /agents and legacy query redirects, /channels room/thread redirect and all current paths. Keep marketplace/sources an independent sibling page. Extension base/splat retains arbitrary raw string search. /dev bypass remains main.tsxDEV-only outside routes. Configure compatible TanStack plugin for client Vite and Electron renderer, deterministic tree and splitting. Update routeID hooks/tests atomically; remove superseded code and eager page imports.

Dependencies: 2.2

### Task 3.2: [session-routing-identity] [P3] Document route contracts and opaque session ownership

Update internal routing/state guides and AGENTS route architecture. Record route inventory, factory rules, generation commands, private link contract, draft vs existing lifecycle, supported external stores and inaccessible native/cloud limitations. Add draft ADR superseding0156 and retain historical old ADR until acceptance. Product prose follows copy skills and does not claim unverified external support.

Dependencies: 1.2, 2.1, 3.1

### Task 4.1: [session-routing-identity] [P4] Verify native loading and creation across every runtime

Run focused unit/conformance suites and meaningful browser tests with fake runtimes/no paid turns. Cover ID-only reload after restart, stale selected cwd, legacy canonicalization, copied URLs without private paths, external native fixture history, creation/pre-message settings/inference source for Claude Code/Codex/OpenCode, missing/unavailable/ambiguous session errors, boundaries, extensions, aliases, shared dialogs and independent marketplace sources. Build client and desktop, scoped typecheck/lint and affected required checks. Independent adversarial review before PR; fix findings, attach actual evidence, land authorized PRs and clean worktree only after merged. Record implemented status only when all required behaviors have evidence.

Dependencies: 1.2, 1.3, 2.1, 2.3, 3.1, 3.2
