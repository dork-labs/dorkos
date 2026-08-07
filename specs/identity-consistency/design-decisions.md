# Design Decisions — identity-consistency

Visual companion session: `.dork/visual-companion/38863-1786052797/` (screens: `directory-and-profile.html`, `team-and-profile-v2.html`). Terminal question rounds ran alongside; both sources merged here. Full rationale table: `01-ideation.md` §6.

## 1. Roster name + route

**Screen:** n/a (terminal; research-backed).
**Options:** People at `/people` (recommended) · Team at `/team` · Directory at `/directory` (original brief).
**Chosen:** **Team at `/team`** — Dorian's pick for control-panel voice. Accepted tradeoff: future agent sub-groupings must use another word (pods/squads). "Directory" was ruled out (Slack reserves it for org-scale search; filesystem collision in a dev tool).

## 2. Team page default arrangement

**Screen:** `team-and-profile-v2.html` §1 (click recorded: `team-b-unified`).
**Options:** A) sectioned roster (People, then Agents) · B) unified grid + filter chips.
**Chosen:** **B — unified grid + filter chips.** One mixed grid, operator first; the shape/badge identity language does the distinguishing; chips filter by kind (All / People / Agents) or by person.

## 3. Person grouping/filtering (Dorian's addition)

**Chosen:** person is a **first-class view axis**, both mechanisms: a "Group: manager" toggle re-clusters agent cards under each person; clicking a person (card or the "by @handle" attribution on an agent card) filters to that person + their agents. Requires `ownerId` on the aggregation payload from day one.

## 4. Card vs table

**Chosen (from the brief, unquestioned):** card grid default, table view toggle (existing `agent-columns.tsx` table is the seed).

## 5. Managed-by semantics

**Chosen:** **owner attribution** — every agent card/hover/profile shows its owning person ("by @dorian"), aligned with `CommunityMemberSchema.ownerMemberId`. Agent-to-agent hierarchy is out of scope (no schema).

## 6. Profile surface

**Screen:** `team-and-profile-v2.html` §2 + terminal follow-up.
**Options:** A) profile drawer (view+edit) · B) full `/profile` page · C) drawer to view, settings to edit.
**Chosen:** **C** — Dorian asked for the best desktop+mobile UX/DX following "Slack and/or Linear"; C is Slack's viewing model (right drawer on desktop, full-screen sheet on mobile; one component for every identity kind — same descriptor family as `IdentityHoverCard`) + Linear's editing model (a **Settings › Profile** tab promoted to the top of Settings). The drawer's Edit button deep-links to Settings › Profile. The avatar-anchored account menu in the app chrome (name, @handle, View profile, Settings, Sign out) is fixed across all options.

## 7. Avatar image source

**Chosen:** **local upload with initials fallback**; storage seam designed to upload/sync to the server when it's available later. `imageUrl` becomes a fourth optional render-cache field beside `displayName`/`emoji`/`color`. No Gravatar.

## 8. Handles sequencing

**Chosen:** **pull DOR-676 (@handles) into this program first**; profiles and roster cards ship with `@handle` from day one. `specs/handles/02-specification.md` is frozen; DOR-675 (blocker) is Done.

## 9. Playground Identity page placement

**Chosen:** dedicated **Identity page under the Agents group**; shared/ui primitives stay cross-listed under Design System → Components. Watch the registry drift test's title-uniqueness when cross-listing.

## Final Design Summary

`/agents` becomes **`/team`**: a unified card grid of every identity on the install — the operator (a real `authors`/Better Auth-backed person, never hardcoded) first, then agents — with filter chips (All / People / Agents / person), a "Group: manager" toggle, a card/table view switch, and search. Every agent card carries owner attribution ("by @dorian"). Cards use the locked identity language: circle/tint for people, square/fill + Bot badge for agents, platform glyph for external identities. Clicking any card opens the shared **profile drawer** (full-screen sheet on mobile) showing avatar, name, `@handle`, kind-specific chips (agent: runtime · model · working state · managed-by; person: role · origin), and actions. The app chrome gains an **avatar-anchored account menu** (View profile · Settings · Sign out). Editing your own identity lives in a promoted **Settings › Profile** tab: photo upload (local file, initials fallback, future server sync), display name, `@handle`, email. The hover card's deferred "View profile" affordance now opens the drawer everywhere.
