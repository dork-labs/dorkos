---
slug: identity-consistency
number: 260806-214542
created: 2026-08-06
status: ideation
design-session: .dork/visual-companion/38863-1786052797
---

# Agent & Human Identity Consistency — people directory, profiles, one identity language

**Slug:** identity-consistency
**Author:** Claude (orchestrated program, directed by Dorian)
**Date:** 2026-08-06

---

## 1) Intent & Assumptions

- **Task brief (Dorian, 2026-08-06):** The way agents and human avatars, names, handles, and lockups display is inconsistent across the app. Make it very consistent: (1) one clear way to distinguish agents from humans everywhere, (2) fewer components via composition + variants, (3) for agents, always be able to tell who an agent is managed by. Transform `/agents` into a Slack-style directory listing humans and agents (research the name; card view default, optional table view). The logged-in user appears in the directory as a real entity, not hardcoded — aligned with where the community server work is heading. Make the user's profile richer and more visible (accounts are buried in settings today); allow a profile image. Give identity components their own Dev Playground section and sweep all identity components into it. Groundwork for Buzz-like features where other people and their agents exist in our app.
- **Assumptions:**
  - The design language locked in `plans/composer-identity-components/design-handoff.md` (square = agent, circle = person, Bot corner badge, fill = agent / tint = person, external = platform glyph) is the convention to generalize — not to redesign.
  - This program extends the shipped DOR-951 identity work (DOR-900/903/904/905) rather than forking a parallel system.
  - Single-user reality today: the directory lists one human (the operator) + their agents. The schema/UX must not need a rewrite when other people and their agents appear (Buzz-like future).
- **Out of scope:**
  - Composer unification, rich text, files-in-rooms (DOR-946/947/948 — separate programme).
  - The community server deployable (`specs/community-server/`, still ideation) and invites execution (`specs/invites/`) — we align with their schemas, we don't build them.
  - Multi-user account lifecycle (DOR-605) beyond what profile surfacing needs.
  - Agent-to-agent management hierarchies (no schema exists; managed-by v1 is owner attribution — see D2).

## 2) Pre-reading Log

Four parallel discovery audits (2026-08-06) + tracker archaeology:

- `plans/composer-identity-components/design-handoff.md`: design-locked identity language; components shipped presentational-first; profiles explicitly deferred ("View profile — soon" in hover card).
- **Identity component audit** (full inventory in §3): convention fully implemented in exactly 2 of ~20+ agent-rendering surfaces; root cause is structural (`AgentAvatar` never sets `shape`/`variant`).
- **Dev playground audit**: 241 sections / 18 pages / 5 sidebar groups; identity coverage fragmented across 3 pages + 5 showcase files; 10 identity sections already exist (> the 5-section threshold for a dedicated page); registration = 6 touch points + a source-scan drift test (`dev/__tests__/playground-registry.test.ts`); `category` metadata is dead code today.
- **User-model audit**: Better Auth `user.image` exists in both auth schemas and is read nowhere; the human is hardcoded `'You'` (`author-registry.ts`, deliberately); `bindOwner` already rebinds the local author to `user:<betterAuthUserId>` keeping opaque id stable; `CommunityMemberSchema` already has `ownerMemberId` (agent → owning member); no query aggregates people+agents across sources; two independent Better Auth instances (local server vs dorkos.ai cloud).
- **Naming research** (fresh web research, 12+ sources): every reference product calls the roster "People" or "Members"; Slack reserves "Directory" for the org-scale searchable index; "Directory" carries filesystem-collision risk in a dev tool; Discord is the only product mixing humans + bots in one list (via role-group sections).
- Tracker: DOR-951 (identity programme, shipped core), DOR-950 (identity follow-ups incl. click-to-profile, touch hover-card, square-at-xs/sm showcase), DOR-949 (seed agent color/icon — only ~16% of agents have an icon, ~5% a color), DOR-675 (done) → DOR-676 (handles, specced) → DOR-677 (operator name/handle/avatar + profile drawer, specced), DOR-605 (account lifecycle, sequenced later). `specs/handles/02-specification.md` covers phases 2–3 in full.
- Prior research: `research/20260724_multi-user-communities.md` (opaque stable ids, A4), `research/20260727_agent-identity-in-communities.md` (owner-vouched admission), `research/20260728_handle-systems-prior-art.md`, `research/20260322_agents_page_fleet_management_ux_deep_dive.md`.

## 3) Codebase Map

- **Identity primitives (shared/ui):** `identity-avatar.tsx` (shape/variant/badge cva; the one disc), `mention-pill.tsx`, `identity-hover-card.tsx` (wired only in room mentions via `widgets/room-view/ui/MentionPillRenderer.tsx`).
- **Entity wrappers:** `entities/agent/ui/AgentAvatar.tsx` (adds health ring + working dot; **never passes shape/variant — the root cause**), `AgentIdentity.tsx` (lockup), `entities/room/ui/RoomAvatar.tsx`, `MemberList.tsx`, `OriginMark.tsx` (room) — plus a _same-named_ `entities/session/ui/OriginMark.tsx` (session launch origin; rename candidate).
- **Convention compliance:** full in `features/chat/ui/message/MessageAuthorAvatar.tsx` (session + room chat gutters) and `identity-hover-card.tsx` only. Violations everywhere else — sharpest where agents and humans sit in one list: `room-management/ui/RoomMemberRow.tsx:185-194` (badge only) and `entities/room/ui/MemberList.tsx:86-100` (no distinction at all).
- **Duplication (merge candidates, ranked):** (1) `AgentAvatar` → fold into `IdentityAvatar` via kind-driven defaults; (2) `RoomMemberRow`/`MemberList` duplicate face-resolution; (3) `AgentPicker` (tasks) / `AgentCommandItem` (palette) structurally identical single-select rows; (4) two copy-pasted color/emoji pickers (`agent-hub/ui/AvatarPickerPopover.tsx` vs `agent-settings/ui/IdentityTab.tsx` — shared `COLOR_PRESETS`/`EMOJI_SET`); (5) four independent provenance chips (`OriginMark`×2, `AccountMark`, `RuntimeMark`) with one interaction shape.
- **`/agents` route:** `router.tsx:254` → `widgets/agents/ui/AgentsPage.tsx` branching on `?view=` (list table via `agent-columns.tsx`, topology via `AgentNode`/`AgentHealthDetail`, ghost/denied/access states). No square/fill agent shape anywhere on the fleet surface.
- **Managed-by:** does not exist in `packages/shared/src/mesh-schemas.ts` (`AgentManifest`/`TopologyAgent` have `namespace` only). The concept exists only as `CommunityMemberSchema.ownerMemberId` (room-scoped, community adapter).
- **User identity data:** `packages/db/src/schema/auth.ts` `user` (`id`,`name`,`email`,`image` — image unused); `packages/db/src/schema/rooms.ts` `authors` (`id` ULID, `kind`, `naturalKey` = `'local'`/`user:<id>`/`agentPath`, `displayName`, `emoji`, `color`); `apps/server/src/services/rooms/author-registry.ts` (`bindOwner`, `LOCAL_HUMAN_DISPLAY_NAME='You'`); `packages/shared/src/config-schema.ts` `UserProfileSchema` (local-only self-description, feeds agent context); account UI: `features/auth/ui/SecurityPanel.tsx` (one email row) + `features/settings/ui/CloudAccountTab.tsx` (cloud link).
- **Playground:** `apps/client/src/dev/` — `playground-config.ts` (PAGE_CONFIGS), `playground-registry.ts` (Page union + sections), `sections/*.ts`, `showcases/*.tsx`, `pages/*.tsx`, `DevPlayground.tsx` (PAGE_COMPONENTS). Mock identities: `dev/mock-samples.ts:785-872` (`MOCK_IDENTITIES`, 8 cast members) + un-unified inline mocks in `AgentIdentityShowcases.tsx`.
- **Potential blast radius:** every agent-rendering surface (~20+ call sites), `/agents` route + nav, settings IA, sidebar footer/topbar (new account menu), server (aggregation endpoint, avatar upload, author display-name policy), playground registration.

## 5) Research

Findings folded into §2/§3. Solution shape per workstream:

- **W1 — One identity language.** Make the convention structural, not opt-in: `IdentityAvatar` gains a `kind` prop (`agent | person | system`) that derives `shape`/`variant`/`badge` defaults; fold `AgentAvatar`'s health ring/working dot in (slot or wrapper folding); sweep all call sites; unify the RoomMemberRow/MemberList face resolution; dedupe pickers; rename session `OriginMark` → `SessionOriginMark`. Add managed-by attribution (D2) to hover card chips + directory cards + agent detail surfaces.
- **W2 — People directory.** Replace `/agents` with a people+agents roster (name per D1): card grid default, table view toggle (existing `agent-columns.tsx` table is the seed), Discord-style sections (You/People · Agents, grouped or filtered), each agent card showing manager attribution. Data: new server aggregation endpoint reading `authors` + `agents` (+ `CommunityAdapter.listMembers()` when live) — a **read surface over existing identity, not a new identity model**. The operator appears from the `authors`/Better Auth record (real name post-`bindOwner`; `'You'` stays room-scoped rendering only).
- **W3 — Profile & account surfacing.** Account menu in the chrome (avatar-anchored, Slack/Discord-style) → profile card → settings; profile editor (display name, handle when DOR-676 lands, avatar image); populate Better Auth `user.image`; `imageUrl` as a fourth optional render-cache field beside `displayName`/`emoji`/`color` (additive, every avatar renderer gains one optional prop); wire the hover card's deferred "View profile". Leverages `specs/handles/` phase 3 (DOR-677) rather than re-deriving it.
- **W4 — Playground Identity page.** Dedicated Identity page consolidating the 10 existing sections + gap coverage (`RoomAvatar`, `AvatarPickerPopover`, `RoomPresenceLine`, square-at-xs/sm from DOR-950); unify mock identity data on `MOCK_IDENTITIES`; respect the 6 registration touch points + drift test; decide cross-listing vs move (anchor URLs change on move).

## 6) Decisions

Resolved with Dorian (terminal question round + visual companion session, 2026-08-06):

| #   | Decision                           | Choice                                                                                                                                                            | Rationale                                                                                                                                                                                               |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Roster name + route                | **Team** at `/team` (Dorian's pick over recommended "People")                                                                                                     | Control-panel voice; reads naturally for "you + your agents". Known tradeoff accepted: if agent sub-groupings ever need a name, call them something else (pods/squads).                                 |
| D1b | Person grouping/filtering          | **The roster must support grouping and/or filtering by person** (Dorian: "easily visualize the agents that belong to a person")                                   | Owner attribution is not just a card chip — it's a first-class view axis. Requires `ownerId` on the aggregation payload from day one.                                                                   |
| D2  | Managed-by semantics v1            | **Owner attribution** — every agent displays its owning person (implied confirmed by D1b phrasing "agents that belong to a person")                               | Matches shipped `CommunityMemberSchema.ownerMemberId`; Buzz-future remote agents already carry it; agent-to-agent hierarchy has no schema and is a different feature.                                   |
| D3  | Handles sequencing                 | **Pull DOR-676 into this program** ahead of profile/roster surfaces                                                                                               | Spec frozen in `specs/handles/02-specification.md`; DOR-675 (blocker) done; profiles/roster land with `@handle` from day one.                                                                           |
| D4  | Profile surface form               | **C — drawer to view any identity (full-screen sheet on mobile), Settings › Profile tab (promoted to top) to edit your own; drawer Edit button deep-links there** | Dorian: "follow Slack and/or Linear" — C is Slack's viewing model + Linear's editing model; one profile-drawer component for every identity kind; form editing belongs on a settled surface for mobile. |
| D5  | Avatar image source                | **Local upload with initials fallback**, architecture ready to upload/sync to the server when available                                                           | Installs run fully offline; `imageUrl` render-cache field is source-agnostic; storage seam must anticipate future cloud sync (Dorian's explicit requirement).                                           |
| D6  | Playground Identity page placement | **Agents group**; shared/ui primitives stay cross-listed under Design System → Components                                                                         | Concept cohesion beside Subsystems and Rooms; watch the registry drift test's title-uniqueness when cross-listing.                                                                                      |
