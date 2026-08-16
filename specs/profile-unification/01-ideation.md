---
slug: profile-unification
created: 2026-08-16
status: ideation
design-session: specs/profile-unification/design
---

# One Profile — fold the Agent Hub and the profile drawer into a single identity surface

**Slug:** profile-unification
**Author:** Claude (design session directed by Dorian)
**Date:** 2026-08-16

---

## 1) Intent & Assumptions

- **Task brief (Dorian, 2026-08-16):** We have two different "profiles": the Agent Profile tab in the right panel on an agent session (really the Agent Hub — Sessions · Config · Toolkit) and the profile drawer that opens from Team cards, the sidebar, mention pills and the account menu. Understand how they work, how they differ, what the user is trying to do in each, and how they should differ by relationship (you vs someone else; an agent you manage vs one you don't). Think about Slack, Buzz and others. Find what is weird and confusing, where to use progressive disclosure, where to simplify, where to delight. Then design an incredible solution in the visual companion. Later in the session: **"the overall hub design is way too busy — what would an S-tier product designer do to dramatically simplify?"** and **"moving forward we shouldn't call it hub anymore."**
- **Assumptions:**
  - The identity language locked by `specs/identity-consistency/` stays: square + fill + Bot badge = agent, circle + tint = person, platform glyph = external. `TeamMember` from `GET /api/team` is the descriptor family; `?profile=<member id>` is the address.
  - Single-user reality today: one operator + their agents. The design must hold when other people and their agents appear (Buzz-like), and for bridged Telegram/Slack people who already exist as room authors.
  - Every capability the Agent Hub offers today (rename, face, personality, model/effort, tool groups, MCP, skills, connections, SOUL/NOPE, set default, block, unregister, delete) survives — it moves, it is not cut.
- **Out of scope:**
  - Multi-user auth/DM delivery to another local person (`specs/accounts-and-auth/`, `specs/invites/`) — we design the rows, we don't build DMs to people.
  - Agent-to-agent hierarchies (managed-by stays owner attribution).
  - Cost/token stats per agent — no per-agent aggregate exists; not promised.
  - Redesign of the right-panel container itself (tab strip, sizing) beyond renaming the tab.

## 2) Pre-reading Log

- `specs/identity-consistency/` (01-ideation §6 decisions, 02-specification W3.2/W3.3, design-decisions.md §6) — the drawer/settings split (ADR `260806-222547`) that this spec **partially supersedes** (see D8).
- `plans/identity-micro-interactions/design-spec.md` — §3D drawer entrance (300 ms, static identity rule, no stagger, no celebration) and §3E refusals; still binding.
- `plans/composer-identity-components/design-handoff.md` — hover card direction A (compact) and the square/circle rule.
- `research/20260806_identity-component-audit.md`, `research/20260727_agent-identity-in-communities.md` (Buzz's `ownerMemberId` vouch), `research/20260611_linear-agent-accounts.md`, `research/20260728_handle-systems-prior-art.md`, `research/20260226_agents_first_class_entity.md` (Approach 4 "Agent Profile as standalone config UI").
- Live browser audit at 1440×900 (screens in the design session dir: `team-page.png`, `drawer-agent.png`, `drawer-you.png`, `session-panel-{profile,config,toolkit,menu}.png`, `session-dorkbot-panel.png`).

## 3) Codebase Map (what exists today)

**Surface 1 — profile drawer** (`apps/client/src/layers/features/profile/`): `ProfileDrawer.tsx` (presentational, any `TeamMember`) + `ProfileDrawerContainer.tsx` (resolves `?profile=<id>`, actions), mounted once in `DialogHost` as dialog contribution `profile` (`widgets/app-layout/model/dialog-contributions.ts`). `ResponsiveSheet` right sheet, full-screen < 768 px. Shows: face, name, `you`/`default`/`system` badges, `@handle`, chip row (runtime · model, liveness words, Managed by, role, origin), facts `<dl>` (Project/Namespace/Joined/Email), footer (Open a session · Edit profile). Callers: Team cards, sidebar agent face + context menu "View profile", mention pills, hover card footer, account menu, mesh `AgentHealthDetail`. Not wired: `PresenceStrip` hover card, room `MemberList`/`RoomMemberRow`, chat `MessageAuthorAvatar`.

**Surface 2 — "Agent Profile" right-panel tab = Agent Hub** (`features/agent-hub/`): contribution id `agent-hub`, priority 10, default tab on `/session`; keyed by agent **path** (`useCurrentAgent(cwd)` → `GET /api/agents/current?path=`), separate Zustand `agent-hub-store` (`activeTab: sessions|config|toolkit`, not persisted). Tree: `AgentHubHero` (kebab → `AgentManagementMenu` dialog; nebula glow; avatar button → `AvatarPickerPanel`; inline rename; status word; `PresetPill` → `PersonalityPickerPanel`) + `AgentHubTabBar` + `SessionsTab` (TasksView + SessionsView), `ConfigTab` (description, runtime/directory, `AgentExecutionRows` model/effort, capabilities, accordions → `agent-settings/IntegrationsTab`, `PersonalityTab`), `ToolkitTab` (SkillPacksList, `agent-settings/ToolsTab` → `AgentMcpServers`). Entry points: ⌘⇧A (`use-agent-profile-shortcut.ts`), status-line `AgentIdentityChip` right-click, sidebar "Agent hub", Team table "Manage", palette, Settings › Runtimes exceptions strip, deep link `?panel=agent-hub&hubTab=&agentPath=`.

**Surface 3 — hover card** (`shared/ui/identity-hover-card.tsx`): glance; `onViewProfile` prop → drawer.

**Edit self** — Settings › Profile (`features/profile/ui/ProfilePanel.tsx`): photo, display name, handle, email (read-only). Writes `PATCH /api/profile`, `POST/DELETE /api/profile/avatar`, `PATCH /api/rooms/authors/:id/handle`.

**Data:** `TeamMemberSchema` (`packages/shared/src/team-schemas.ts`) — `id, kind, displayName, handle|null, emoji?, color?, imageUrl?, isSelf, ownerId|null, origin, agent?{manifestId, runtime, model?, healthStatus, recentlyActive, namespace?, projectPath?, isDefault, isSystem, registeredAt}, person?{role, email?}`. `ownerId` is derived at read time (every non-system agent → the operator); nothing is gated on it. Real live-turn signal lives in `services/rooms/room-claims.ts` (`claimsWorkingIn`) — not joined into the roster. `projectPath`/`namespace` are stripped by `toManifest()` so the drawer's "Open a session" never renders in production.

**Bugs found in the audit (fix as part of this work):**

1. Hub hero status is permanently "Offline" — `healthStatus` is not on `AgentManifestSchema`; `GET /api/agents/current` never carries it (`AgentHubHero.tsx` casts through `AgentWithHealth`).
2. Drawer "Open a session" never renders (`projectPath` stripped server-side).
3. `?hubTab=toolkit` silently falls to `sessions` (`use-agent-hub-deep-link.ts` `VALID_HUB_TABS`).
4. Hub inner tab is not persisted; outer tab is.
5. System-agent guards are server-only — hero offers rename/face/personality on DorkBot, server answers 403 `SYSTEM_PROTECTED`.
6. `DeleteAgentDialog.tsx` is orphaned; `AccordionSection` duplicated in ConfigTab/ToolkitTab; stale comments/test names.
7. `PresenceStrip` hover card footer still says "soon"; room member rows and chat author avatars have no profile entry.

## 4) What the user is trying to do (the two contexts, honestly)

| Context               | Trigger                                                         | Question in the user's head                                                              | Today's answer                                                    |
| --------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Looking someone up    | Team card, sidebar face, mention pill, hover card, account menu | Who is this? Whose is it? Is it alive? How do I reach it?                                | Face + 3 chips + "Joined". No actions.                            |
| Working with an agent | `/session` right panel, ⌘⇧A, "Manage"                           | What is this agent set up as? Change model / personality / tools; see its other sessions | A settings workbench labelled "Agent Profile" that says "Offline" |

Both are the same subject seen at different depths. Slack solves it with **one** profile panel that appears from everywhere (right panel on desktop, full screen on mobile) with the primary action up top and details below; admin/manage links sit inside it. That is the shape we adopt.

## 5) Research summary (patterns borrowed)

- **Slack:** one profile from everywhere; Message first; details as rows; app profiles carry an admin door. **Linear:** issue sidebar = flat property list where every row is the control; agent accounts show owner + current work. **iOS Contacts / Settings:** portrait header, push-in pages with a back link, groups by spacing. **Discord:** popout (peek) → full profile. **GitHub:** hover card → page. **Buzz:** agent vouched by a human owner; the link is drawn both ways.

## 6) Decisions

Resolved with Dorian in the visual companion (session `7451-1786856918`, screens `01`–`05`) on 2026-08-16:

| #   | Decision                      | Choice                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                    |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How many profile things exist | **B — one Profile, two homes.** One component; docked in the right panel on `/session`, slide-over sheet everywhere else, same `?profile=<id>` address. The Agent Hub ceases to exist as a separate surface.                                                                  | Slack's model; what identity-consistency already wanted ("one component, every identity kind"). A (align + link) is a patch; C (`/team/@handle` page) adds a fourth surface. |
| D2  | Header                        | **Portrait** — face centered with its colour wash, name (+ badges), `@handle`, one status sentence, who it belongs to, one button.                                                                                                                                            | Reads like a person's card; calm; the phone layout for free.                                                                                                                 |
| D3  | Body shape                    | **Properties (Linear).** After the header: a flat list of rows grouped by spacing, no section labels, no inner tab bar. If you manage the identity, **the row is the control**.                                                                                               | Cuts four competing navigation systems to one. Densest and quietest; Kai/Priya's preference; Ikechi only sees arrows.                                                        |
| D4  | Push-in pages                 | Rows marked **›** push a page that takes the **full height** of the panel. Only **"‹ Profile"** and a small identity strip (face · name · live status) stay at the top; then a title; the content owns the rest. **▾** rows open a small popover. **⧉** copies. Nothing else. | Dorian: "when I click into Sessions it should take pretty much the full height, except for a back link and the small avatar/card."                                           |
| D5  | Managed by                    | Lives in the **header, above the button** (owner face + name, tap → pushes the owner's profile). People get a **Manages** row (face stack + count → list of their agents). DorkBot reads **"System agent"** in that slot (Dorian's pick over "Part of DorkOS").               | Buzz's vouch link drawn both ways; profiles chain on one stack.                                                                                                              |
| D6  | The one button                | **Message** — agent → open/continue its session; person → DM; bridged → DM via that platform. **Hidden** on your own profile and **hidden when docked in that agent's own session** (the composer is right there).                                                            | Only show a button when it does something.                                                                                                                                   |
| D7  | Tasks not Schedule            | The row is **Tasks · 2 scheduled · next 9:00 ›** and pushes the agent-filtered Tasks list (runs + schedules). Presets appear only when the list is empty.                                                                                                                     | Dorian: "what is schedule… I assume that's tasks?"                                                                                                                           |
| D8  | Editing yourself              | **Keep both**: your own rows (Name, Handle, Photo, Email) are controls in the profile **and** Settings › Profile stays as the form.                                                                                                                                           | Dorian's pick (option 2). Amends ADR `260806-222547` "drawer to view, settings to edit" — viewing and editing now share the profile; Settings remains a second door.         |
| D9  | Naming                        | **"Hub" is retired** from copy and code. Tab = **Profile**. One verb everywhere = **View profile** ("Manage", "Agent hub", "Open profile" go away). ⌘⇧A keeps its meaning. `features/agent-hub` folds into `features/profile`.                                                | One word, one component.                                                                                                                                                     |

## 7) The Profile — behaviour spec (for the specification stage)

**Header (fixed order):** face → name + badges (`you` / `default` / `system`) → `@handle` (tap = copy) → status sentence → belongs-to line → the button. Nothing else lives in the header. Kebab (⋮) top-right holds only: Set as default · Copy @handle · Block · Unregister · Delete (typed confirm; danger last). Tap the face (own agent) → face + personality picker.

**Status sentence** — from the real live-turn signal (`claimsWorkingIn`/session activity), not the 60-min mesh window: "Replying to you in #team · 2 min" → "Working in ~/dorkos · 5 min" → "Last active 3 h ago" → "Hasn't run yet". People: "On this machine" / "Last seen 3 h ago" / "On Telegram".

**Rows by identity (arrows only where you may act):**

| Identity                     | Rows                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You**                      | Name › · Handle › · Photo › · Email 🔒 ‖ Manages [faces] N › · Rooms ›                                                                                                                                                 |
| **Another person**           | Role · Manages [faces] N › · Rooms ›                                                                                                                                                                                   |
| **Bridged (Telegram/Slack)** | Rooms › · First seen                                                                                                                                                                                                   |
| **Your agent**               | About › · Runs on ▾ (runtime · model · effort) · Personality ▾ · Folder ⧉ ‖ Sessions N · last › · Tasks › · Rooms › ‖ Skills › · Tools & MCP › · Connections › · Instructions (SOUL.md) › · Boundaries (NOPE.md) ›     |
| **Someone else's agent**     | About · Runs on · Rooms › (private things — sessions, tools, instructions — are not shown)                                                                                                                             |
| **DorkBot**                  | About 🔒 · Runs on ▾ · Personality 🔒 ‖ Sessions › · Tasks › · Rooms › ‖ Skills › · Tools & MCP › — kebab: Set as default only. Locked rows stay visible; tap explains ("DorkBot's name and face are part of DorkOS"). |

**Push-in pages (all share the top: "‹ Profile" + strip):** Sessions (search + day groups; the live one first), Tasks, Rooms, About (description editor), Skills, Tools & MCP, Connections, Instructions / Boundaries (full-height editor + Save), Manages (agent list, each row pushes that agent's profile), an owner's profile (chained).

**Motion:** on push the portrait shrinks into the strip (same face, same colour wash), the list slides left; back reverses; ~250 ms, position-only. Sheet entrance stays 300 ms with the static identity rule (per identity-micro-interactions §3D). No celebration on open, ever.

**Homes:** `/session` → docked in the right panel as tab **Profile** (default tab, priority 10; per-agent persistence of the _stack_ position is fine but the root is the default on re-open). Everywhere else → `ResponsiveSheet` (full-screen < 768 px). One address: `?profile=<member id>&page=<sessions|tasks|…>`; `?panel=agent-hub&hubTab=…` and `?agent=…` redirect. Resolver: member id ⇄ agent path via `useMeshMemberIds`; the panel on `/session` resolves the current cwd → member id.

**Read-only rule:** the same list minus arrows; no Save; ▾ becomes plain text.

## 8) Open questions carried into SPECIFY

- Where does the live-turn signal join the roster payload (extend `TeamAgentFacts` with `working?: {roomId|sessionId, since}` vs a separate presence query)?
- `projectPath` on the roster: unstrip for the operator's own agents (needed for Folder ⧉ and Message → session).
- ~~Sessions row for the operator's own profile~~ — decided: **no** (Dorian, 2026-08-16). All sessions on this machine are yours; the sidebar owns that list.
- Someone else's agent: is Message allowed by default, or gated by the community/room policy?

## 9) Next steps

1. `/flow:specify` → `02-specification.md`: component contract (`Profile`, `ProfilePage` stack, `ProfileRow` kinds), data plan (presence join, unstrip projectPath), migration plan from `features/agent-hub`, deep-link redirects, playground Identity page updates, e2e (`RightPanelPage`, `team-page.spec`).
2. ADR: amend `260806-222547` (D8) and record D1/D3/D4/D9 as one ADR ("A profile is one surface with two homes and a push-in stack").
3. Linear: umbrella under project "Team, Identity & Profiles".
