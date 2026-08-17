---
slug: profile-unification
created: 2026-08-16
status: specified
design-session: specs/profile-unification/design
---

# One Profile — specification

Ideation and the decision table live in `01-ideation.md` (§6 D1–D9, §7 behaviour). The visual record is `design-decisions.md`; the reviewed screens are copied into `design/` (`05-states-final.html` is the approved reference; `04-properties-pushin.html` shows the push-in pattern). This document is the build contract.

## 0) Summary

Replace two surfaces — the profile drawer (`features/profile/ui/ProfileDrawer.tsx`) and the "Agent Profile" right-panel tab (`features/agent-hub/`) — with **one `Profile` component** that has **two homes** (a right-panel tab on `/session`, a right sheet everywhere else) and a **push-in navigation stack**. The header is a **Portrait**; the body is a **property list** where the row is the control if you manage the identity; rows marked › push a **full-height page** under a fixed top ("‹ Profile" + identity strip). "Hub" disappears from copy and code.

## 1) Component contract (client, `features/profile/`)

All new code lives in `apps/client/src/layers/features/profile/`. `features/agent-hub/` is deleted at the end (W5); its reusable guts (`PersonalityPicker`, `PersonalityRadar`, `AvatarPickerPanel`, `AgentManagementMenu`, `AgentExecutionRows`, `SkillPacksList`, presets) move under `features/profile/` (or `entities/agent/` where they are pure entity UI). `features/agent-settings/` (IntegrationsTab, ToolsTab, AgentMcpServers, PersonalityTab, ConventionFileEditor) stays and is composed by pages.

### 1.1 `ProfileView`

```ts
interface ProfileViewProps {
  member: TeamMember; // roster row (any kind)
  roster: TeamMember[]; // for owner + manages resolution
  home: 'docked' | 'sheet';
  /** True when the profile is docked inside the session that IS this agent's session. Hides Message. */
  inOwnSession?: boolean;
  stack: ProfileStackState; // see 1.3
  onPush(entry: ProfileStackEntry): void;
  onPop(): void;
  onClose?(): void; // sheet only
}
```

Derived, never passed: `relationship = member.isSelf ? 'self' : member.agent?.isSystem ? 'system' : member.kind === 'agent' && member.ownerId === selfId ? 'managed' : member.origin !== 'local' ? 'bridged' : 'other'`.

Renders `ProfileHeader` + (`ProfileRoot` | `ProfilePage`) inside a `ProfileStackFrame` that animates push/pop.

### 1.2 `ProfileHeader` (Portrait)

Fixed order, nothing else: face (`IdentityAvatar` size lg, identity colour radial wash behind, square/circle per kind; own-agent → tap opens face + personality picker) → name + badges (`you` / `default` / `system`) → `@handle` (tap copies; omitted when `null`) → **status sentence** → **belongs-to line** → **Message button**. Kebab (⋮) top-right.

- **Status sentence** (`profileStatusText(member)`), from `member.agent.activity` (new, §3.1) or person facts: agent — `working` → "Working in #team · 2 min" (room label when known, else "Working · 5 min"; the data records a claim in a room, never whom the turn addresses — no "Replying to you" variant); else `lastActiveAt` → "Last active 3 h ago"; else "Hasn't run yet". Person — self "On this machine"; other `lastSeenAt` → "Last seen 3 h ago" else "On this machine"; bridged "On Telegram" (`platformLabel`). Words only, never a coloured ring on the face (identity-micro-interactions rule); a 7 px dot before the sentence is allowed and is the only live indicator (green = working, muted = idle).
- **Belongs-to line**: agent with owner → owner face (16 px) + "Managed by {label}" (label = "You" for self), tap → `onPush({kind:'profile', memberId: owner.id})`; system agent → "System agent" (no face); person → none.
- **Message**: rendered only when `messageTarget(member) != null` and not (`relationship==='self'` or `inOwnSession`). Agent → `navigate('/session', {dir: agent.projectPath})` (+ `recordOpened('agent', projectPath)`). Person/bridged → **no target today** (no DM-to-person route exists) → button not rendered. Never a dead button.
- **Kebab**: managed agent → Set as default · Copy @handle · Block/Unblock · Unregister · Delete (typed confirm; reuse `AgentManagementMenu` step machine, renamed `ProfileActionsMenu`); system agent → Set as default · Copy @handle; self → Copy @handle; other → Copy @handle (omit kebab if only Copy and no handle).

### 1.3 Stack, rows, pages

```ts
type ProfileStackEntry =
  | { kind: 'page'; page: ProfilePageId }
  | { kind: 'profile'; memberId: string }; // chained profile (owner / managed agent)
interface ProfileStackState {
  rootMemberId: string;
  entries: ProfileStackEntry[];
}
type ProfilePageId =
  | 'about'
  | 'sessions'
  | 'tasks'
  | 'rooms'
  | 'skills'
  | 'tools'
  | 'connections'
  | 'instructions'
  | 'boundaries'
  | 'manages'
  | 'name'
  | 'handle'
  | 'photo';
```

- `ProfileRow` kinds: `nav` (›, pushes a page), `pick` (▾, opens a popover; managed only), `copy` (⧉), `locked` (🔒 + reason on tap/hover via tooltip), `text` (read-only value). A row's `kind` is decided by relationship (§1.4). Rows are `<button>`s (nav/pick/copy/locked) or plain `<div role="row">` (text); keyboard reachable, `focus-visible` ring; value truncates with `text-overflow: ellipsis`, label never wraps.
- Groups: hairline-separated blocks with 8–10 px gap between blocks, **no group labels**.
- `ProfilePage` shell: top bar = `‹ Profile` back button + `ProfileStrip` (26 px face · name · status sentence, single line, ellipsis) → `h2` title (+ optional meta) → content that owns the remaining height (`flex-1 min-h-0 overflow-auto`). Search field only on Sessions.
- **Motion**: push = header portrait → strip (shared layout via `motion` `layoutId` on the face; ~250 ms), page slides in from the right; pop reverses. Sheet entrance stays the drawer's 300 ms + static identity rule (`identity-micro-interactions` §3D). No celebration on open. `prefers-reduced-motion` → crossfade only.

### 1.4 Rows by relationship (the contract; see `design/05-states-final.html`)

| Relationship     | Rows (group ‖ group)                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| self             | Name › · Handle › · Photo › · Email 🔒 ‖ Manages [face stack] N › · Rooms N ›                                                                                                                                                                                            |
| other person     | Role (text, only if set) · Manages N › · Rooms ›                                                                                                                                                                                                                         |
| bridged          | Rooms › · First seen (text)                                                                                                                                                                                                                                              |
| managed agent    | About › · Runs on ▾ · Personality ▾ · Folder ⧉ ‖ Sessions N · last › · Tasks N scheduled · next › · Rooms › ‖ Skills N › · Tools & MCP N › · Connections › · Instructions › · Boundaries ›                                                                               |
| other's agent    | About (text) · Runs on (text) · Rooms ›                                                                                                                                                                                                                                  |
| system (DorkBot) | About 🔒 · Runs on ▾ · Personality ▾ ‖ Sessions › · Tasks › · Rooms › ‖ Skills › · Tools & MCP › — _amended in execution: personality is a control (onboarding writes it; the server allows `traits`); "Set as default" is hidden once the agent already is the default_ |

Locked reasons: "DorkBot's name, face and description are part of DorkOS." Row values are live counts from existing hooks: Sessions = `useAgentSessions(projectPath).length` + newest `updatedAt`; Tasks = schedules for `agent.id` (+ next run when the tasks tool is enabled; hidden when disabled by server); Skills = installed skill-packs at `projectPath`; Tools & MCP = enabled managed servers count; Rooms = `useMemberRooms(member.id).length` (§3.2); Manages = roster rows with `ownerId === member.id`.

Popovers (managed only): **Runs on** = runtime select + model + effort with provenance (port of `AgentExecutionRows` + runtime select from `ConfigTab`), inside `ResponsivePopover`; **Personality** = `PersonalityPicker compact`. Face tap → `AvatarPickerPanel` **as a pushed page** ("Appearance": colour + emoji), not a popover — the picker is large.

### 1.5 Pages

| Page                      | Content                                                                                                           | Source of truth today                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| about                     | Description textarea (managed) or read-only text; capabilities chips (managed)                                    | `ConfigTab` description + capabilities |
| sessions                  | Search · day groups (`groupSessionsByTime`) · live session first · `SessionRow variant="full"` (fork/rename kept) | `SessionsView`                         |
| tasks                     | Agent-filtered runs + schedules; presets **only when empty**                                                      | `TasksView`                            |
| rooms                     | Rooms this member is in (name · kind glyph · members) → row navigates to `/channels?id=`                          | new `useMemberRooms`                   |
| skills                    | `SkillPacksList` + "Browse skill-packs"                                                                           | `ToolkitTab`                           |
| tools                     | tool-group tri-states + `AgentMcpServers`                                                                         | `agent-settings/ToolsTab`              |
| connections               | `IntegrationsTab`                                                                                                 | `agent-settings`                       |
| instructions / boundaries | `ConventionFileEditor` full height + Save + saved-at                                                              | `PersonalityTab`                       |
| manages                   | Agent list (face · name · status) → row pushes `{kind:'profile'}`                                                 | roster filter                          |
| name / handle / photo     | The matching `ProfilePanel` FieldCard, one per page, reusing `use-profile-edits`                                  | `ProfilePanel`                         |

Read-only relationships never reach editing pages (rows are `text`).

### 1.6 Homes

- **Sheet**: `ProfileSheetContainer` replaces `ProfileDrawerContainer` under the same dialog contribution id `profile` (`?profile=<memberId>`), plus new param **`profilePage`** (`ProfilePageId`) so a page is addressable. Stack state for the sheet lives in the URL only (root + one page — deep stacks reset on reload; chained profiles rewrite `?profile=` and push history so back works). `ResponsiveSheet` unchanged (full-screen < 768 px).
- **Docked**: right-panel contribution **`id: 'profile'`, `title: 'Profile'`, `icon: User`**, same `visibleWhen`/priority as today's `agent-hub`. Component `ProfileDock` resolves the session's agent → member id (`useCurrentAgent(cwd)` → `useMeshMemberId(path)` → roster row) and renders `ProfileView home="docked" inOwnSession`. Its stack lives in `profile-store.ts` (Zustand, per member id, LRU like the right-panel layout store; **root on re-open** — persistence is for mid-session tab flips only). `NoAgentSelected` / `AgentNotFound` / skeleton states carry over.
- **Address rule on `/session`**: `?profile=<id>` where `<id>` is the current session's agent → open the right panel on the Profile tab (and push `profilePage` if given), then clear the params; any other id → sheet. Implemented in `ProfileSheetContainer` (it already resolves the member).
- **Legacy deep links**: `?panel=agent-hub` → `?panel=profile`; `hubTab=sessions` → `profilePage=sessions`; `hubTab=config|toolkit` → root; `?agent=…`/`?dialog=agent` keep redirecting (existing `useAgentDialogRedirect`, retargeted). `?panel=profile&profilePage=…&agentPath=…` is the new external form (Settings › Runtimes exceptions strip uses `profilePage=about`? — no: it opens the **Runs on** popover; use root and let the strip's copy say "Open profile").
- Shortcut ⌘⇧A: unchanged binding, catalogue label "Agent profile" → "Profile".

## 2) Verbs and naming (sweep, W5)

One verb: **View profile** for visible menu items and buttons; accessible names stay `Open {name}’s profile` ("Open your profile" for yourself — the repo majority, asserted by e2e). Rename or retarget: sidebar `AgentRowMenuItems` "Agent hub" (remove; "View profile" stays), `SidebarChrome`/`SidebarModelRow` `onOpenProfile` (retarget to `useProfileDeepLink().open`), Team `agent-columns` "Manage" → "View profile", `AgentsList` manage handler, `AgentIdentityChip` context item "Agent Hub" → "View profile" (fallback path opens docked profile), palette actions `openAgentProfile`, `ExecutionExceptionsStrip`, e2e `RightPanelPage.agentProfileTab` and `right-panel-tab-strip.spec` ("Agent Profile" → "Profile"), `capture/surfaces-desktop.ts` personality shot (opens the profile, taps the face → Appearance page → personality), docs/contributing prose (`grep -ri "agent hub\|agent-hub\|hubTab"`), playground showcases (`PersonalityPickerShowcases` import path; `ProfileShowcases` gains the six states + a pushed page), `.claude` rules if any mention. `DeleteAgentDialog.tsx` deleted. Store `agent-hub-store` deleted (its `openHub` callers → `openProfileDocked(memberId|path, page?)` in `profile-store`).

## 3) Server changes

### 3.1 Roster facts (`packages/shared/src/team-schemas.ts`, `apps/server/src/services/identity/aggregate-team.ts`)

- `TeamAgentFactsSchema` gains `activity: { working: { roomId: string; roomName: string | null; since: string } | null; lastActiveAt: string | null }` (required object, nullable members) — one field, always present, so the client never guesses.
  - `working` from `claimsWorkingIn`-equivalent read over active claims for the agent's author id (`services/rooms/room-claims.ts`, `ActiveClaimView`), joined to the room name; `since = claimedAt`.
  - `lastActiveAt` = max(mesh `lastSeenAt`, sessions `agentActivity[projectPath]` from `listRecentSessions`, last room entry by that author) — whichever sources are cheap inside the existing 2 s per-source budget; document which were used.
- `projectPath` is **populated for local agents** (the operator's own and system agents): the `agents` source reads registry entries (not `toManifest()` output) — `TeamAgentSource` already accepts `projectPath`. `namespace` stays stripped. Schema comment updated (it currently promises they are never filled).
- `TeamPersonFacts` gains `lastSeenAt: string | null` (self → now; others → last authored room entry; bridged → last entry).
- Contract tests: `aggregate-team` unit tests for `activity` in the working / idle / never states and for `projectPath` presence on local agents; degradation envelope unchanged (a failing claims read → `activity.working = null`, not a failed roster).

### 3.2 Rooms by member

`GET /api/team/:memberId/rooms` → `{ rooms: Array<{ id, name, kind, memberCount }> }` — rooms whose membership includes the author row for that member (person → the author id; agent → author row via `mintedForManifestId`; system → its author row). Route in `routes/team.ts`, service `services/identity/member-rooms.ts` over `RoomService`/store (add `listRoomsForAuthor(authorId)` to the store if absent). Transport: `team-methods.ts` `listMemberRooms(memberId)`, Direct transport too. Client hook `useMemberRooms(memberId, {enabled})` in `entities/team`. Tests: route + service + hook.

## 4) Data flow, keys, invalidation

- Roster query `['team']` (30 s stale) is the profile's spine; while a profile is open, `refetchInterval: 15_000` so the status sentence moves. Mutations from pages/popovers invalidate `['team']` plus their existing keys (`['agents','byPath',path]`, mcp, tasks…). Renames/face changes must invalidate both `['team']` and `['agents','byPath']` so header and rows agree.
- Member id ⇄ agent path: `useMeshMemberIds` (`entities/mesh`). Docked home resolves path → id; sheet resolves id → row (already) → `agent.projectPath` for Message/sessions/skills.
- The docked and sheet homes never both show the same member: the address rule (§1.6) routes to the dock on `/session`.

## 5) Accessibility & responsive

- Header face button `aria-label="Change {name}’s face and personality"` (managed) or none (plain art). Handle button `aria-label="Copy @handle"`, toast "Copied". Rows: `nav` → `aria-label="{Label}: {value}"` + `aria-haspopup` for `pick`. Locked rows expose the reason via `aria-describedby`.
- Pushed page: back button first in DOM, `aria-label="Back to profile"`; focus moves to the page title on push and back to the originating row on pop.
- < 768 px: sheet is full-screen; pushed pages are full-screen; the strip stays; the right-panel dock is a full-width `ResponsiveSheet` already.
- All colours via theme tokens; identity colour only through `--identity-color` (existing pattern).

## 6) Testing

- Unit: `ProfileView` per relationship (six fixtures from `design/05-states-final.html`): header order, Message presence rules (self / inOwnSession / no target), belongs-to line, rows and their kinds, locked reasons, status sentence for each activity state; `ProfileStack` push/pop + focus management; `ProfileSheetContainer` address rule (docks on `/session` for the current agent, sheets otherwise); legacy deep-link redirects (`panel=agent-hub`, `hubTab`); `profile-store` persistence semantics (root on re-open).
- Server: aggregate-team activity states + projectPath; member-rooms route (200 / 404 unknown member / degraded).
- E2E (apps/e2e): update `RightPanelPage` (`profileTab`), `right-panel-tab-strip.spec` (title "Profile"), `team-page.spec` (card → sheet still asserts `?profile=` + `data-slot="profile"`), `dialog-deep-link.spec` (`panel=profile&profilePage=sessions`, legacy `panel=agent-hub` redirect); new `profile-pushin.spec`: open Sessions from the docked profile → full-height page with back link; back returns focus.
- Playground: `ProfileShowcases` shows the six roots + Sessions page + Instructions page; `PersonalityPickerShowcases` import fixed.
- Final: real-browser pass of the whole flow (Team card → sheet → Manages → chained profile → back; `/session` → docked → Sessions → back; DorkBot locked rows; legacy deep link) at 1440×900 and 390×844.

## 7) Work breakdown (waves; one worktree, one builder, one adversarial reviewer, one PR each)

| #    | Task                                                                                                                                                                                                                                                 | Depends on                                    | Owns                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1.1 | Server: roster `activity` + `lastSeenAt` + `projectPath` for local agents                                                                                                                                                                            | —                                             | `packages/shared/src/team-schemas.ts`, `services/identity/aggregate-team.ts` (+ sources), tests                                                          |
| W1.2 | Server + client data: `GET /api/team/:memberId/rooms`, transport, `useMemberRooms`                                                                                                                                                                   | —                                             | `routes/team.ts`, `services/identity/member-rooms.ts`, `shared/lib/transport/team-methods.ts`, `entities/team`                                           |
| W1.3 | Wire missing profile entry points: `PresenceStrip` hover card, room `MemberList`/`RoomMemberRow`, `MessageAuthorAvatar` → View profile                                                                                                               | —                                             | those files + tests                                                                                                                                      |
| W2.1 | Profile shell + sheet home: `ProfileView`, header, rows, stack, page shell, self/other/bridged/other's-agent/system rows, `name`/`handle`/`photo`/`manages`/`rooms`/`about(read)` pages, `profilePage` param, address rule, replaces `ProfileDrawer` | W1.1, W1.2                                    | `features/profile/**` (new), `shared/model/dialog-search-schema.ts`, `use-dialog-deep-link.ts`                                                           |
| W2.2 | Managed-agent pages + popovers: sessions, tasks, skills, tools, connections, instructions, boundaries, about(edit), appearance page; Runs on + Personality popovers; kebab actions — ported from agent-hub                                           | W2.1                                          | `features/profile/ui/pages/**`, `features/profile/ui/popovers/**`, moved pickers                                                                         |
| W2.3 | Docked home: right-panel contribution `profile`, `ProfileDock`, `profile-store` (replaces `agent-hub-store`), ⌘⇧A, legacy deep-link redirects, `AgentIdentityChip` fallback                                                                          | W2.1 (parallel with W2.2; owns no page files) | `app/init-extensions.ts`, `features/right-panel/model/*`, `features/profile/model/profile-store.ts`, `use-agent-hub-deep-link` → `use-profile-deep-link` |
| W3.1 | Sweep: one verb, delete `features/agent-hub`, rename callers, e2e + capture + playground + docs + changelog fragment, knip clean                                                                                                                     | W2.2, W2.3                                    | everything in §2                                                                                                                                         |
| W4.1 | Final browser verification (desktop + mobile), spec closeout (`04-implementation.md`, manifest → implemented), ADRs                                                                                                                                  | W3.1                                          | spec dir, decisions/                                                                                                                                     |

## 8) Non-goals / what is deliberately not done

- No DM-to-person or DM-via-Telegram button: no route exists; the button is hidden, not stubbed.
- No `/team/@handle` page; no per-agent cost/token stats; no agent-to-agent hierarchy.
- The right-panel tab icon stays a Lucide `User` (the registry takes `LucideIcon`, not a node); "the identity face as the tab icon" is a follow-up.
- Settings › Profile stays (D8). No new config fields.
