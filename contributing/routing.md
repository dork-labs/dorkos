# Routing Guide

## Overview

The web app and desktop renderer share TanStack file-based routes and typed navigation factories. Session links carry opaque identities; the server owns runtime bindings and private filesystem locations.

## Key Files

| Concept                             | Location                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Thin route declarations             | `apps/client/src/routes/`                                                                            |
| Generated tree and router context   | `apps/client/src/routeTree.gen.ts`, `apps/client/src/router.tsx`                                     |
| Shared web/desktop generator        | `apps/client/router-plugin.ts`                                                                       |
| Search schemas and session loader   | `apps/client/src/app/route-search.ts`, `apps/client/src/app/session-route-loader.ts`                 |
| Typed core destinations             | `apps/client/src/layers/shared/lib/route-factory.ts`                                                 |
| Session navigation and pure hrefs   | `apps/client/src/layers/shared/lib/session-link.ts`, `packages/shared/src/session-link.ts`           |
| Runtime ownership and native lookup | `apps/server/src/services/core/runtime-registry.ts`, `packages/shared/src/agent-runtime.ts`          |
| Private launch references           | `apps/server/src/routes/session-locations.ts`, `packages/db/src/schema/session/session-locations.ts` |

## When to Use What

| Scenario                               | Approach                                           | Why                                                             |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| Navigate to a core page                | `appRoutes` from the shared barrel                 | TanStack checks the destination; changes stay centralized.      |
| Open an existing conversation          | `toSession({ session: sessionId })`                | The server resolves runtime and cwd; an agent ID is optional.   |
| Start with an agent                    | Explicit draft plus `agentId`                      | Launch intent differs from an existing-session read.            |
| Start in an unregistered folder        | Reserve a location, then put its ID in `launchRef` | Any allowed folder works without exposing its path.             |
| Send a session URL from server/desktop | Shared `sessionPath`                               | Pure href generation does not depend on React or async lookup.  |
| Render an extension destination        | Existing extension-page factory                    | Extension paths have separate namespacing and search contracts. |

## Core Patterns

### Typed navigation

```tsx
import { Link } from '@tanstack/react-router';
import { appRoutes, toSession } from '@/layers/shared/lib';

export function NavigationExample({ sessionId }: { sessionId: string }) {
  return (
    <nav>
      <Link {...appRoutes.team()}>Team</Link>
      <Link {...toSession({ session: sessionId })}>Session</Link>
    </nav>
  );
}
```

Factories return navigation options. Add typed search and history behavior at the call site; use a search updater when opening a shared dialog must preserve existing search.

### Private launch folders

`Transport.createSessionLocation(cwd)` posts `{ cwd }` to `/api/session-locations` and returns `{ id }`. `getSessionLocation(id)` returns `{ cwd }` only to the caller who owns it. Keep the resolved path in session route context, not search parameters. The same private references address a docked profile through `profileRef`, independently of the conversation folder. `profile=<roster ID>` continues to address the profile sheet.

Locations survive restart, reuse canonical paths per caller and have a fixed cap. Registration and resolution enforce the person bar and the session filesystem boundary, including only the data directory’s `agents/` subtree for system agents. Other data folders, including credentials, remain excluded. Cross-site requests are refused. Resolution revalidates stored paths so a changed boundary or retargeted symlink cannot widen access.

### Existing sessions and drafts

An existing `session` reference resolves details first, then hydrates cwd/runtime and directory-specific query keys. A different globally selected directory must not change where history, streams or message submission run. A missing existing session is an error, not permission to create one.

`draft=1` marks an optimistic conversation whose native session may not exist yet. Its agent or `launchRef` supplies launch context. Preserve runtime selection, pre-message settings and inference-source choices; subscribing before the first message must continue working. The first message establishes native state and durable ownership once.

### Native discovery

Durable ownership takes precedence over defaults. An optional runtime `findSession` performs read-only native lookup without caller cwd; verified native existence and an allowed directory are prerequisites to persisting a new binding. Unknown or ambiguous identities cannot silently pick the default runtime. Unavailable stores remain distinguishable from missing sessions.

Accessible Claude Code account/project JSONL, local Codex thread stores and the managed OpenCode sidecar are native discovery surfaces. Ordinary ChatGPT chats, cloud-only tasks without an access contract, and unrelated OpenCode instances are outside this contract. Discovery never creates, resumes or sends a turn. Transcript storage remains runtime-owned.

## Anti-Patterns

- ❌ Hardcode `to="/team"` or assemble `/session?session=...`; ✅ use typed factories.
- ❌ Require an agent registration to read a session; ✅ resolve session identity independently.
- ❌ Put an absolute path, encoded path or reversible path hash into a new link; ✅ use an opaque launch reference.
- ❌ Treat every detail 404 as a draft; ✅ carry explicit draft intent.
- ❌ Infer native cwd from a Claude project slug; ✅ read verified transcript metadata.
- ❌ Edit the generated tree by hand; ✅ change route modules and regenerate through Vite.

## Route Inventory

| Public path            | Search/layout contract                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `/`                    | Home room under `_shell/_home`; legacy `?session=` redirects.             |
| `/activity`            | Home layout; activity filters stay page-specific.                         |
| `/tasks`               | Home layout; inherited root search.                                       |
| `/workspaces`          | Home layout; inherited root search.                                       |
| `/team`                | Agent/team search and shared dialogs.                                     |
| `/agents`              | Alias redirect to `/team`, preserving meaningful search.                  |
| `/session`             | Existing identity or explicit draft; legacy private search canonicalizes. |
| `/channels`            | Room/thread/entry context; team-room redirects preserve thread and entry. |
| `/connections`         | Connections search; legacy `?relay=` redirects here.                      |
| `/marketplace`         | Validated marketplace search.                                             |
| `/marketplace/sources` | Independent sibling page; never renders inside the marketplace page.      |
| `/feedback-requests`   | Inherited root search.                                                    |
| `/x/$extensionId`      | Registered extension base page; arbitrary string-valued search.           |
| `/x/$extensionId/$`    | Extension splat; preserve exact strings such as `1.10`.                   |
| `/dev/*`               | DEV-only `main.tsx` bypass; outside the generated tree.                   |

Root onboarding search is inherited. Each route must declare `staticData.header`, including `null` for layouts and redirect-only routes. `_shell` owns the app shell; `_home` preserves the shared tabbed surface. Keep route-ID hooks and tests aligned with generated IDs. Custom search parsing/stringification is part of the extension compatibility contract.

## Adding or Changing a Route

1. Add a thin module under `src/routes/`; import FSD components through their barrels. Supply search validation, loader and header data as needed.
2. Extend the navigation factory and migrate callers. AST lint governs internal navigation literals; route declarations, actual factories and deliberate external/API contracts have narrow exemptions.
3. Run a client build to regenerate the tree. Client Vite and Electron renderer instantiate their own `tanstackRouter` plugins using shared `clientRouterOptions`. This keeps each plugin matched to its app’s Vite peer version; retain the generated tree with the change.
4. Verify direct reloads, redirects, search preservation and layout behavior. Build both surfaces for a route-tree change.

## Troubleshooting

### A known session opens the wrong folder

Check server ownership/cwd resolution and the client session route context. Do not repair this by appending a filesystem path to the canonical URL.

### A new conversation returns 404 before its first message

Check the explicit draft marker and launch context. Expected draft absence must not mask a missing existing session or trigger an unrelated runtime.

### An extension query value changes from `1.10` to `1.1`

Restore the custom router search parser/stringifier. Default coercion loses information extensions own.

## Research and Privacy Rationale

TanStack supports both route styles and recommends [file-based routes](https://tanstack.com/router/latest/docs/routing/file-based-routing). Its [link options](https://tanstack.com/router/latest/docs/framework/react/guide/link-options) provide reusable, typed navigation objects. Our factories build on those options; they centralize intent without replacing router validation.

Legacy `dir` search supplied the project context required by runtime storage. The path itself grants no filesystem access, but exposes usernames and project names through copied links, history, logs and same-origin referrers. [The default referrer policy](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Referrer_policy) normally sends only the origin across origins, but sends the full URL within an origin. Opaque references reduce disclosure; server ownership and boundary checks still enforce access.

Existing-session links need only the session ID. Agent IDs describe launch intent or agent provenance; they are not required to open a native conversation. New conversations carry explicit draft intent plus an agent ID or a private launch reference. Legacy profile `agentPath` links resolve into a separate opaque `profileRef` before their paths are removed. A linked profile must never change the conversation folder. Current profile actions use roster IDs or internal dock state.
