---
slug: session-routing-identity
number: 261006-180000
created: 2026-10-06
status: specified
---

# Private routes and reliable session identity

**Status:** Approved for implementation by the user's 2026-10-06 instruction
**Author:** Codex with Dorian Collier
**Date:** 2026-10-06

## Overview

Make internal navigation consistent, use thin file-based TanStack route modules, and open existing sessions by opaque identity across all three runtimes. Remove filesystem paths from normal browser URLs while preserving new-session creation and native external-session discovery in accessible stores.

## Background / Problem Statement

The route tree grew from three routes to twelve static destinations plus extension routes. Existing session factories and a narrow AST guard do not govern all links. A real session returns 404 without `dir` even when durable metadata contains its directory. Pre-message settings can create a live Claude session without cwd; first-message initialization previously failed to fill it. Unknown session ownership defaults to Claude Code. Codex's DorkOS registry/event projection does not by itself discover or render external native threads. Directory query parameters expose usernames and project names in copied links and browser history.

## Goals

- One typed factory surface for internal links with lint enforcement and no manual session-query construction.
- Thin file route modules, generated type tree and splitting in web and desktop builds without changing existing destination semantics.
- Existing sessions load with session identity alone, without agent registration or directory-bearing canonical URLs.
- New conversations preserve optimistic IDs, runtime selection, chosen settings, funding/credential decisions and directory initialization.
- Claude Code, Codex and OpenCode load details/history/stream consistently after restart.
- Native external sessions load when their native store is accessible, including locally stored Codex desktop threads.
- Compatibility paths accept old links without retaining private paths in canonical URLs.

## Non-Goals

- Ordinary ChatGPT chats or inaccessible cloud-only tasks; remote OpenCode instances not configured as native stores.
- Launching agent turns as part of discovery, importing transcripts into a new unified transcript store, or changing source-of-truth runtime ownership.
- Redesigning route page contents or changing route paths beyond removal of private query locations.

## Technical Dependencies

- Current React 19, TanStack Router ^1.170.39, Vite 6 and Electron Vite configuration. Use a router plugin version compatible with the installed Router.
- Existing Zod schemas, Transport, AgentRuntime, Drizzle session metadata and per-runtime alias tables.
- Codex app-server `thread/list` and `thread/read` supported by the installed native transport; filesystem reads remain inside configured homes and boundaries.
- https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing
- https://tanstack.com/router/latest/docs/framework/react/guide/link-options
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

## Detailed Design

### Route inventory and migration invariants

| Public path            | Semantics to preserve                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `/`                    | Shared home layout and legacy `?session=` redirect                  |
| `/activity`            | Shared home surface and header metadata                             |
| `/team`                | Agent/team page; existing typed hook route IDs updated together     |
| `/agents`              | Redirect alias to `/team`, preserving meaningful search             |
| `/session`             | Existing session reference or explicit draft launch context         |
| `/tasks`               | Task page and inherited root search behavior                        |
| `/channels`            | Room/channel search, team-room redirects retaining thread and entry |
| `/workspaces`          | Workspace page and inherited root search behavior                   |
| `/connections`         | Connections search and legacy `?relay=` redirect                    |
| `/marketplace`         | Marketplace page and validated search                               |
| `/marketplace/sources` | Independent sibling page, never nested marketplace page content     |
| `/feedback-requests`   | Feedback page and inherited root search behavior                    |
| `/x/$extensionId`      | Registered extension page                                           |
| `/x/$extensionId/$`    | Extension splat; preserve arbitrary string-valued search            |
| `/dev/*`               | DEV-only main.tsx bypass, outside generated route tree              |

Create `apps/client/src/routes/` outside FSD layers. Root and pathless `_shell` and `_home` route modules compose existing barrel-exported components. Preserve query client/transport context, shared dialog validation, root onboarding search, route header staticData and custom parse/stringify search functions. Extensions must retain strings such as `1.10` without coercion. Use flat route conventions or explicit non-nesting naming for marketplace sources. Header data must not accidentally defeat splitting by importing every page eagerly. Configure the route generator in client Vite and desktop renderer builds, with consistent generated-tree location and deterministic generation. Remove superseded hand-built route assembly and update literal route-ID hooks/tests atomically.

### Typed navigation

Extend current session helpers rather than creating a competing generator. The canonical app-root route declaration module can supply structural schemas; lower FSD layers consume a shared typed factory barrel without importing app-root code at runtime. Use TanStack `linkOptions` or equivalently checked typed option objects for client navigation. Keep pure href generation in shared code for server/desktop notifications. Include all static routes, room/thread navigation, marketplace sources and extension page destinations. Existing `sessionLink(sessionId)` semantics identify an existing session. `newSessionLink({agentId})` or an opaque workspace reference identifies launch intent. Preserve search merging where navigation opens shared dialogs.

Add an AST ESLint rule for hardcoded internal navigation destinations in JSX Link/href and router navigate/redirect options. Allow route declarations, factory implementation, deliberate external/API URLs, test fixtures and documented extension author contracts. Do not use an indiscriminate string regex. Keep or adapt the existing session-link boundary test so server and desktop href construction is also governed. Migrate every violation, rather than leaving broad file exemptions.

### Identity resolution and native discovery

A known DorkOS session reference resolves to server-owned metadata: runtime, native identifier/alias where applicable, working directory and optional agent association. Persisted ownership remains first-write-wins; directory updates must not rebind an existing session to a different runtime. Explicit legacy cwd is boundary-checked and must not override authoritative ownership.

Introduce optional `AgentRuntime.findSession(sessionId): Promise<Session | null>` for read-only native discovery without a caller cwd; Session supplies actual cwd and runtime-owned alias metadata remains in the runtime. Resolution order: durable identity, live binding, supported native lookup, then a verified default-directory lookup for backward compatibility. Probe unbound identities without choosing a runtime merely because it is the default. No match returns not found; ambiguous cross-runtime matches are rejected instead of silently choosing. Registered but unavailable runtimes report unavailable rather than falling back to another runtime. Native session aliases map to stable DorkOS references where the native identifier is not the public identifier. Persist a binding only after native existence and allowed directory are verified.

Claude Code lookup enumerates accessible configured account roots/project stores and reads transcript metadata, including CLI-created JSONL, without parsing project slug back into a filesystem location as authority. Codex lookup enumerates accessible native homes, uses thread list/read or supported native-store reads, maps thread to DorkOS identity and renders native history before any DorkOS event log exists. Do not create or resume a thread to discover it. OpenCode lookup reads the managed sidecar's native sessions and directory metadata and preserves ses_* alias mapping; a separate inaccessible sidecar is unsupported, not an empty successful transcript.

Retain runtime-owned transcript storage (ADR-0310). Native Codex history may be projected into the existing read representation, but discovery must not invent a new transcript source of truth. Avoid double-counting imported native history when live DorkOS events begin.

### Server endpoints and client hydration

Apply identity resolution consistently to details, history, tasks, SSE, WebSocket, limits/continuation and message submission. For known sessions the server's actual cwd and runtime are authoritative even if the client has another directory selected. Preserve authorization, boundary checks and client locks after resolution. Missing native history is not a successful empty result unless the native session is genuinely empty.

The client loader fetches existing-session detail by reference alone and hydrates directory/runtime state and matching query keys without writing a directory into the URL. Session history and streams must wait for identity resolution where they need it. The composer uses resolved cwd/runtime for an existing session, never a stale global directory. Legacy `dir`/`agentPath` links are accepted long enough to resolve and are replaced by canonical opaque links. Agent launches resolve agent directory server-side. Unregistered launch directories use opaque workspace references owned by the server; do not encode, hash reversibly, or send a raw path in the URL as a privacy workaround.

### New-session lifecycle

Distinguish an explicitly created draft from an unknown existing-session link. A draft can reserve an optimistic ID and subscribe before its first native session exists. Preserve pre-message settings and selected inference source; first message creates native state once and establishes durable ownership/directory. Read-only existing-session navigation never creates a native session. A 404 for an existing reference shows missing session; a draft's expected 404 does not send it through an error loop. Switching agent/workspace resets only the draft context as existing UI contracts require. The interim persisted-cwd fix remains, while its directory-bearing client redirect is replaced.

## User Experience

Copied session links contain only opaque identity and safe view parameters. Clicking one opens the correct history and composer regardless of the currently selected workspace. Choosing an agent or workspace starts a draft exactly as today. Opening a discovered native session needs no agent registration. Missing sessions display a concise actionable state; unavailable runtime/store errors remain distinguishable. Legacy links work and become canonical without exposing directories. No discovery triggers an agent turn.

## Testing Strategy

- Unit tests carry purpose comments: builder search preservation, canonical links without paths, lint true positives/false positives, draft-vs-existing validation and custom extension search serialization.
- Runtime conformance: ID-only detail/history/stream after restart for Claude Code, Codex and OpenCode; durable alias binding; unbound native external discovery; unavailable and ambiguous ownership; boundary rejection; pre-message settings and optimistic subscription; no creation/resume/send during read discovery.
- Native fixtures: Claude JSONL outside default dir, Codex desktop/native-home thread with no DorkOS registry row, native OpenCode ses_* session. Verify nonempty native history where fixture contains messages.
- Browser tests: new-session creation for each test runtime with settings retained, existing ID-only reload with stale selected directory, legacy URL canonicalization, copied link privacy, extension splat/search, legacy aliases, shared dialog and marketplace-sources behavior. Fake/test runtimes prevent any billed turn.
- Build both client and desktop renderer; scoped typecheck/lint/tests then repository required affected verification. Do not claim broad external support from mocks alone; verify native-reader fixtures and document inaccessible store limits.

## Performance Considerations

Prefer durable indexed resolution; cold native discovery is bounded to configured roots and paginated APIs, not arbitrary recursive home scans. Cache successful lookup and invalidate on deletion or store changes. Runtime failures are isolated. Generated route splitting reduces startup page imports; check emitted chunks in both renderer builds.

## Security Considerations

URL encoding does not conceal filesystem paths. Avoid paths in hrefs, query parameters, copied links, browser tabs and notifications. Keep auth/owner checks and canonical filesystem boundary validation on resolved native cwd. A runtime-provided path is untrusted until checked. No agent is required for an external session, but that does not weaken session ownership. Do not disclose inaccessible paths in errors. Discovery is read-only and preserves funding consent and per-account native home isolation.

## Documentation

Update routing and state-management developer guides, AGENTS routing inventory, session linking guidance and native discovery limitations. Add an implementation evidence record covering each runtime and creation path. New architectural decisions supersede ADR-0156 only when accepted; keep historical ADR text intact.

## Implementation Phases

- **Phase 1 — Identity foundation:** runtime-neutral lookup, native readers and creation-safe lifecycle.
- **Phase 2 — Private navigation:** opaque launch context, client hydration, typed factories and enforcement.
- **Phase 3 — Route modules:** generated tree, both builds, route parity and documentation.
- **Phase 4 — Verification:** independent review, complete lifecycle/runtime/native fixtures, affected checks and review-ready PR.

## Open Questions

- ~~(RESOLVED) Must every existing link carry an agent ID?~~ **Answer:** No. **Rationale:** Native external sessions may be unregistered; actual session cwd can differ from the agent directory.
- ~~(RESOLVED) Does missing detail imply a new session?~~ **Answer:** Only explicit draft launch context allows pre-creation absence. **Rationale:** Unknown existing identities must not silently create or select a different runtime.
- ~~(RESOLVED) Which external sessions are supported?~~ **Answer:** Native sessions in accessible configured local stores; cloud-only ChatGPT chats and inaccessible separate OpenCode stores are excluded. **Rationale:** Identity discovery requires authorized native-store access.
- ~~(RESOLVED) Delegation model names?~~ **Answer:** Use the configured model when named legacy Opus/Sonnet choices are unavailable. **Rationale:** Available runtime models must be used without blocking authorized work; record this execution assumption.

## Related ADRs

ADR-0154 (TanStack Router), ADR-0156 (code-based route tree, to be superseded), ADR-0255 (session runtime ownership), ADR-0310 (runtime-owned storage), ADR-0309/0308 (Codex/OpenCode), draft 261006-180100 (thin file routes and opaque identity).

## References

- DOR-2716: settings-before-first-message and ID-only detail lookup failure.
- DOR-1322: historical cwd-less history issue; DOR-1836: bare session loader; DOR-2077: malformed session links.
- User reproduction: session `d95cd27a-608d-49f5-9f56-54c6019a7821`, directory `/Users/doriancollier/Keep/tangerines` (diagnostic evidence only, never a product fixture or default).

## Changelog

- 2026-10-06: Initial implementation contract incorporates the complete routing audit and all user requirements.

## Compatibility Clarification

Legacy `dir` describes a session launch folder. Legacy `agentPath` describes a docked profile subject, which may differ from the conversation's agent. It must not be treated as session cwd. Convert that subject to an owner-scoped opaque `profileRef` before session or legacy-root redirects remove its path; resolve it privately in the dock. Preserve `profilePage` and retain `profile=<roster ID>` for sheet addressing.
