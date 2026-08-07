---
slug: identity-consistency
id: 260806-214542
created: 2026-08-06
status: specified
---

# Agent & Human Identity Consistency — the Team page, profiles, one identity language

**Status:** Specified (frozen for DECOMPOSE)
**Author:** Claude (orchestrated program, directed by Dorian), SPECIFY stage
**Date:** 2026-08-06
**Ideation:** `specs/identity-consistency/01-ideation.md` (§6 decisions D1–D6 are authoritative)
**Design record:** `specs/identity-consistency/design-decisions.md`
**Discovery audits:** `research/20260806_identity-component-audit.md` · `research/20260806_dev-playground-structure-audit.md` · `research/20260806_user-model-and-community-plans-audit.md`
**Design language:** `plans/composer-identity-components/design-handoff.md` (locked; generalized here, not redesigned)
**Prerequisite spec:** `specs/handles/02-specification.md` Phase 2 (DOR-676) — consumed, never re-specified
**Tracker:** DOR-676 (prerequisite W0, existing) · DOR-677 (partially absorbed) · DOR-962 (absorbed) · DOR-957 (delivered) · DOR-950 (split) · DOR-955 (external, in progress) · DOR-954 / DOR-949 (related, separate)

---

## Overview

DorkOS draws an agent and a person with the same disc almost everywhere. A colourblind-safe
convention exists and works — **square is the agent shape, circle the person shape**, agents filled
with their own colour, a `Bot` corner badge, a platform glyph for someone bridged in from outside —
and it fires in exactly two of the twenty-odd surfaces that draw an identity
(`MessageAuthorAvatar.tsx:70-72` and `identity-hover-card.tsx:120-122`). Everywhere else, an agent
is a tinted circle, pixel-identical in silhouette to a human.

This program makes that convention **structural instead of optional**, replaces `/agents` with
**`/team`** — one roster of every identity on this install, the operator first and their agents
under them — and gives the person at the keyboard a **profile they can see and edit**, with a photo,
instead of one email row buried in Settings › Security.

Four workstreams, in dependency order:

| #      | Workstream                  | One line                                                                                                                                                  |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0** | Handles (DOR-676)           | Prerequisite, already specified elsewhere. Every author gets an `@handle`.                                                                                |
| **W1** | One identity language       | `kind` drives shape/fill/badge; the duplicate face-resolvers, pickers and presets merge; agents carry owner attribution.                                  |
| **W2** | The Team page               | `/team` replaces `/agents`: unified card grid, filter chips, group-by-manager, card/table switch, backed by one new read-only aggregation endpoint.       |
| **W3** | Profile & account surfacing | Avatar-anchored account menu, one profile drawer for any identity, a promoted Settings › Profile tab, local avatar upload with a sync-ready storage seam. |
| **W4** | Playground Identity page    | One home for every identity showcase, the gaps closed, the mocks unified.                                                                                 |

The load-bearing constraint across all four: **this is a read surface and a rendering convention, not
a new identity model.** No second person schema, no second roster table, no second avatar system.

## Background / Problem Statement

### The convention is real, and it is skipped by construction

`IdentityAvatar` (`apps/client/src/layers/shared/ui/identity-avatar.tsx:137`) already carries the whole
vocabulary: `shape` (`circle` | `square`, cva at `:41-44`), `variant` (`tint` | `fill`, `:54-57`), and a
bottom-right `badge` slot whose own TSDoc states the rule — _"agents get the glyph, people get
nothing. Absence is the signal"_ (`:85-105`). It is deliberately kind-agnostic: _"the mapping from an
actual `kind` … to a `{ shape, variant, badge }` triple belongs to the caller"_ (`:122-127`). That was
the right call for FSD (a room cannot import `entities/agent`), and it is also why the convention is
skipped: **mapping a kind to a triple is opt-in, and almost nobody opts in.**

The root cause is one file. `AgentAvatar` (`entities/agent/ui/AgentAvatar.tsx:39`) is the base every
non-chat agent surface builds on, and it never passes `shape` or `variant`, so it inherits
`circle`/`tint`. Twelve production call sites go through it (enumerated in §W1.3), plus `AgentIdentity`,
which multiplies it across the sidebar, the status line and the fleet table. The violation is
**inherited, not repeated** — which is also why it is cheap to fix.

The sharpest version is where agents and humans sit in the _same_ list and still differ only by a
small corner badge, or not at all:

- `features/room-management/ui/RoomMemberRow.tsx:185-194` — explicit `IdentityAvatar` call with
  `badge={isAgent ? <Bot /> : undefined}` and **no `shape`/`variant`**.
- `entities/room/ui/MemberList.tsx:86-100` — badges only _external_ members. An agent and a local
  human are the same shape, the same fill, and carry the same nothing.

Both files independently implement "resolve one room member's face" — the same
`color ?? …`, `emoji ?? …`, `fallback={initialOf(displayName)}` ladder, one file apart, with the
shape/badge decision made **differently in each**.

### Nobody can tell who an agent belongs to

There is no `managedBy`, `parentId`, `ownerId` or `reportsTo` anywhere on `AgentManifest` or
`TopologyAgent` (`packages/shared/src/mesh-schemas.ts:288-358, 443-451`). The only grouping concept is
`namespace` (`:300`), a project-directory string used for cross-agent messaging permissions. The one
adjacent concept that exists is `CommunityMemberSchema.ownerMemberId`
(`packages/shared/src/community-adapter.ts:456-464`) — _"the member who vouched for this one, for an
agent admitted under `agentAdmission: 'owner-vouched'`"_ — which is exactly the relationship a
Buzz-like roster needs and which nothing renders today.

### The person at the keyboard is a hardcoded string

`author-registry.ts:74` mints one human author per install with
`LOCAL_HUMAN_DISPLAY_NAME = 'You'`. Better Auth's `user` table has `id`, `name`, `email` and **`image`**
(`packages/db/src/schema/auth.ts`), and `image` is read nowhere in the product; `findOwnerAccount()`
(`services/core/auth/accounts.ts:45-54`) deliberately selects only `{ id, name }`. The entire
account UI is one row in Settings › Security (`features/auth/ui/SecurityPanel.tsx`) plus a separate
cloud-link tab. There is no avatar anywhere in the cockpit that is not an emoji, a colour or a letter.

And there is **no query that lists everyone on this install**. `authors` holds the local roster,
`agents` holds the mesh registry, `CommunityAdapter.listMembers()` is scoped to one room in one
community. Nothing joins them.

### `/agents` is a fleet table, not a roster

`router.tsx:254` → `widgets/agents/ui/AgentsPage.tsx:22`, branching on `?view=`: a table whose identity
column draws `AgentAvatar` (`features/agents-list/lib/agent-columns.tsx:85`), a React-Flow topology, and
two access-gate states. The detail panel for a selected topology node (`AgentHealthDetail.tsx:62`) has no
avatar at all — just a coloured dot. **No square/fill agent shape appears anywhere on the one page
dedicated to agents.** And the operator does not appear on it, because the page has no concept of a
person.

## Goals

- **G1 — The convention becomes impossible to skip.** `IdentityAvatar` derives `shape`/`variant`/`badge`
  from a `kind` prop; `AgentAvatar` can no longer be handed a `shape`; every surface in the audit's §b
  table renders an agent as square/fill/`Bot`.
- **G2 — One resolver, one row, one preset list.** The duplicate face-resolution
  (`RoomMemberRow`/`MemberList`), the duplicate single-select agent row (`AgentPicker`/`AgentCommandItem`),
  and the duplicate `COLOR_PRESETS` (`IdentityTab`/`AvatarPickerPopover`) each collapse to one
  implementation. The two same-named `OriginMark` components stop colliding.
- **G3 — Every agent shows who it belongs to**, on its card, in its hover card, and in its profile —
  from a field that already means this in `CommunityMemberSchema`, carried on the roster payload from
  day one so grouping-by-person is a client filter and not a later migration.
- **G4 — `/team` is one roster of every identity on this install**, operator first, with kind and person
  filters, a group-by-manager toggle, a card/table switch and search — served by **one read-only
  aggregation over `authors` and `agents`**, degrading per source in the ADR-0310 shape.
- **G5 — The operator is a real entity, never a literal.** The roster returns the account's real name;
  `'You'` stays a room-scoped rendering choice and the stored constant is untouched.
- **G6 — A profile is one component for every kind**, opened from anywhere an identity is drawn, viewed
  in a right drawer on desktop and full-screen on a phone, edited in a promoted Settings › Profile tab.
- **G7 — A photo is a fourth optional render-cache field**, stored locally under `~/.dork` behind a
  storage interface a future server or cloud backend can implement without touching a single renderer.
- **G8 — The playground has one Identity page**, drift-test green, mocks unified on `MOCK_IDENTITIES`,
  and the four uncovered identity components covered.

## Non-Goals

Explicitly out of scope. Each is named because it is adjacent enough to be assumed in.

- **Composer unification, rich text, files-in-rooms** — DOR-946 / DOR-947 / DOR-948, a separate programme.
- **The community server deployable** (`specs/community-server/`, still `ideation`) and **invites
  execution** (`specs/invites/`). This spec aligns with their schemas; it does not build them.
- **Remote members.** No membership, no admission, no relay. W2's card and roster components must
  _accept_ a remote person without rework (§W2.6), and nothing more.
- **Multi-user account lifecycle** — DOR-605 — beyond what surfacing one profile needs.
- **Agent-to-agent management hierarchy.** No schema expresses it; managed-by v1 is owner attribution
  (D2).
- **Gravatar, cloud avatar fetch, or any network avatar source.** Local upload only (D5). The dorkos.ai
  cloud account stays a separate link and is not reconciled here (§W3.6).
- **Re-encoding or resizing uploaded images.** No new image dependency (§W3.5).
- **Seeding agent colours/icons** — DOR-949, a separate product decision.
- **Touch long-press on the hover card** — stays with DOR-950 (§Relationship to Existing Tracker Items).
- **Renaming agents or changing `AGENT_NAME_REGEX`** — owned by `specs/handles`.

## Technical Dependencies

No new runtime dependency in any package.

| Need                                         | Already present                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Multipart upload                             | `multer@^2.2.0` — `apps/server/package.json:63`, used today by `routes/uploads.ts:19-67`                                               |
| File streaming + range/nosniff/CSP precedent | `apps/server/src/routes/files.ts:49-135`                                                                                               |
| Data directory                               | `resolveDorkHome()` — `apps/server/src/lib/dork-home.ts:15-21` (the **only** export; `os.homedir()` is banned outside it, Hard Rule 3) |
| Desktop/mobile switching                     | `useIsMobile()` — `shared/model/media/use-is-mobile.ts:6`, breakpoint `768` (`:3`)                                                     |
| Responsive menu                              | `ResponsiveDropdownMenu` — `shared/ui/responsive-dropdown-menu.tsx:34`                                                                 |
| Right-side panel pattern to generalize       | `RightPanelContainer.tsx:199-216` (`Sheet side="right"`, `w-full sm:max-w-full` on mobile)                                             |
| Dialog deep-linking                          | `dialogSearchSchema` (`shared/model/dialog-search-schema.ts:17-30`) + `use-dialog-deep-link.ts:154-235`                                |
| Tabbed settings                              | `TabbedDialog` / `TabbedDialogTab<T>` — `shared/ui/tabbed-dialog.tsx:24-45, 104`                                                       |
| Table seed                                   | `features/agents-list/lib/agent-columns.tsx` + `DataTable`                                                                             |
| Per-source degradation                       | `SessionListWarningSchema` (`packages/shared/src/schemas.ts:597-615`), `aggregate-session-list.ts:99-142`, `routes/sessions.ts:80-91`  |

`@dorkos/shared` gains two new subpath exports (`./team-schemas`, and `./handle` if DOR-676 has not
already added it) — additive entries in the `exports` map of `packages/shared/package.json`.

---

## Detailed Design

### W0 — Handles (prerequisite, referenced only)

`specs/handles/02-specification.md` Phase 2 (**DOR-676**) is frozen and lands **before** any surface in
this spec. It delivers `authors.handle`, `packages/shared/src/handle.ts`, the tombstone table, the
boot-time reservations, the human's handle prompt in the first-run flow, `PATCH
/api/rooms/authors/:id/handle`, and the collapse of `AuthorRef.mentionHandle` into
`AuthorRef.handle: string | null`.

**This spec consumes three things from it and re-specifies none of them:**

1. `AuthorRef.handle` — every roster and identity payload here carries a handle field of the same
   shape and the same nullability semantics (`null` = "cannot be addressed", already rendered honestly
   by the picker at `mention-rows.ts:96-99`).
2. `PATCH /api/rooms/authors/:id/handle` — the **only** write path for a handle. Settings › Profile
   (§W3.3) calls it and adds no second route. Its three typed refusals (`HANDLE_TAKEN`,
   `HANDLE_RESERVED`, `INVALID_HANDLE`) are surfaced verbatim in the form.
3. The invariant that **no agent-reachable path writes a handle** (handles spec S6). Nothing in this
   spec creates one.

If DOR-676 slips, W1 and W4 still land; W2 ships with `handle: null` on every row and the roster's
"by @handle" attribution degrades to the owner's display name. W3's Settings › Profile handle field
is the one thing that cannot ship without it.

---

### W1 — One identity language

#### W1.1 `IdentityAvatar` gains `kind`

```typescript
// apps/client/src/layers/shared/ui/identity-avatar.tsx

/**
 * What this identity IS. Supplying it derives `shape`, `variant` and `badge`
 * so a caller cannot draw an agent as a person by forgetting three props —
 * the failure this component shipped with, in 18 of 20 places that draw one.
 *
 * Explicit props still win: pass `shape`, `variant` or `badge` and the
 * derivation steps aside for that axis only. `badge={null}` is the explicit
 * "no badge here", which an agent-only list uses to avoid a column of
 * identical glyphs.
 *
 * Omitting `kind` reproduces the pre-`kind` defaults exactly (circle, tint,
 * no badge), so this is additive and no existing call site changes meaning.
 */
kind?: AuthorKind;   // 'human' | 'agent' | 'system' — from @dorkos/shared/room-schemas
/** Where a human is posting from. Only read to derive an external badge. */
origin?: IdentityOrigin;  // already defined at shared/ui/identity-origin.ts
```

**Derivation table** — the design-handoff rules, made code:

| `kind`                          | `shape`  | `variant` | `badge`                                  |
| ------------------------------- | -------- | --------- | ---------------------------------------- |
| `agent`                         | `square` | `fill`    | `<Bot />`                                |
| `human`, `origin` local/absent  | `circle` | `tint`    | _(none — absence is the signal)_         |
| `human`, `origin: { platform }` | `circle` | `tint`    | `ADAPTER_LOGO_MAP[platform] ?? <Send />` |
| `system`                        | `circle` | `tint`    | _(none)_                                 |
| _(omitted)_                     | `circle` | `tint`    | _(none)_                                 |

**Why `'human'` and not `'person'`.** The brief proposed `'agent' | 'person' | 'system'`. The repo's
identity vocabulary is already `AuthorKindSchema = z.enum(['human','agent','system'])`
(`packages/shared/src/room-schemas.ts:42`), reused verbatim by `CommunityMemberSchema.kind`
(`community-adapter.ts:441`), `MentionPill`, `IdentityHoverCardDescriptor`, `MessageAuthor` and the
playground's `MockIdentity`. A second spelling would force every call site to translate
`author.kind === 'human'` into `kind="person"` — a mapping that exists only to be forgotten, which is
the exact class of bug this workstream removes. **The prop takes `AuthorKind`.** "Circle is the person
shape" stays the sentence we write in docs and TSDoc; it is not a value on the wire.

**Two mechanical consequences to implement:**

- The badge render guard changes from `badge !== undefined` (`identity-avatar.tsx:183`) to `badge != null`,
  so `null` is a real opt-out and does not render an empty plate.
- `IdentityAvatar` imports `AuthorKind` (a type) from `@dorkos/shared/room-schemas` and
  `ADAPTER_LOGO_MAP` from `@dorkos/icons`. Both are cross-package imports, not layer violations
  (`.claude/rules/fsd-layers.md`, "Cross-Package Imports Are Fine"). The component stays presentational:
  it reads a kind, it does not fetch, resolve or know where the kind came from.

#### W1.2 `AgentAvatar` — narrowed wrapper plus one new slot (merge candidate #1)

The audit ranks folding `AgentAvatar` into `IdentityAvatar` first. **Deleting it is the wrong shape of
fold**: its remaining job — a health ring keyed on `AgentHealthStatus` — is mesh vocabulary that
`shared/` must not learn, and pushing it to 12 call sites would hand-roll a ring twelve times. The fold
is therefore _downward on the parts that are presentational, and a narrowing on the part that is not_:

1. **`IdentityAvatar` gains `working?: boolean`** — a top-right pulsing dot, mirroring the existing
   bottom-right `badge` slot. It uses the `bg-status-success` token, rings itself in `bg-background`,
   and drops the ping under `motion-reduce:hidden` while keeping the dot. This is presentational and
   kind-agnostic on purpose: a person in a Buzz-future roster can be working too.
   It replaces **two** hand-rolled copies — `AgentAvatar.tsx:49-53` (which uses the hardcoded
   `bg-emerald-500`, an anti-pattern under `.claude/rules/components.md`) and
   `RoomMemberRow.tsx:196-213`.
2. **`AgentAvatar`'s props narrow.** It stops extending
   `VariantProps<typeof identityAvatarVariants>` (`AgentAvatar.tsx:21`), which is precisely how a caller
   could pass `shape="circle"` and re-break the convention. Its props become
   `{ color, emoji, size?, healthStatus?, working?, imageUrl?, className? }` and it hard-passes
   `kind="agent"`. **The convention is now unskippable through this path.**
3. The health ring stays exactly where it is — `HEALTH_RING[healthStatus]` merged through `className`
   (`AgentAvatar.tsx:47`) — no new API, no mesh vocabulary in `shared/`.

**Migration for the 12 call sites: none of them change.** Verified by grep — every production call site
passes only `color`, `emoji`, `size`, `healthStatus` and `className`; not one passes `shape` or
`variant`. Narrowing the props type is therefore source-compatible, and **all twelve gain
square/fill/`Bot` from a single edit to the base**:

| #   | Call site                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `features/mesh/ui/AgentNode.tsx:71`                                                                                               |
| 2   | `features/mesh/ui/AgentNode.tsx:113`                                                                                              |
| 3   | `features/settings/ui/runtimes/ExecutionExceptionsStrip.tsx:108`                                                                  |
| 4   | `features/tasks/ui/AgentPicker.tsx:53`                                                                                            |
| 5   | `features/tasks/ui/AgentPicker.tsx:97`                                                                                            |
| 6   | `features/chat/ui/FirstLight.tsx:47`                                                                                              |
| 7   | `features/agents-list/lib/agent-columns.tsx:85`                                                                                   |
| 8   | `features/agent-hub/ui/AgentHubHero.tsx:211`                                                                                      |
| 9   | `features/dashboard-sidebar/ui/RecentSessionRow.tsx:45`                                                                           |
| 10  | `features/command-palette/ui/AgentCommandItem.tsx:71`                                                                             |
| 11  | `widgets/dashboard/ui/AgentCard.tsx:30`                                                                                           |
| 12  | `entities/agent/ui/AgentIdentity.tsx:109` (which carries the sidebar, the status-line chip and the agent-settings hero behind it) |

What _does_ change is `entities/agent/__tests__/agent-identity.test.tsx:18-57`, which asserts
`rounded-full` and the emerald dot. Those assertions are the **red-before/green-after evidence** for this
change and must be updated to assert the square radius, the fill background and the `status-success`
dot — not deleted.

#### W1.3 The sweep — acceptance checklist

Every row in the audit's §b table, with what it needs. Rows marked _via base_ need **no edit**; they are
listed so the sweep can be verified rather than assumed.

| #   | Surface                      | File:line                                       | Action                                                                                                                                               |
| --- | ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Session chat gutter          | `MessageAuthorAvatar.tsx:64-75`                 | already correct — refactor to pass `kind` instead of the hand-mapped triple                                                                          |
| 2   | Room chat gutter             | `RoomEntryRow.tsx:489`                          | inherits #1                                                                                                                                          |
| 3   | `@mention` hover card        | `identity-hover-card.tsx:115-124`               | already correct — refactor to pass `kind`                                                                                                            |
| 4   | Topology graph               | `AgentNode.tsx:71,113`                          | _via base_                                                                                                                                           |
| 5   | Fleet table identity column  | `agent-columns.tsx:85`                          | _via base_                                                                                                                                           |
| 6   | Command-palette agent row    | `AgentCommandItem.tsx:71`                       | _via base_ (and merged in W1.5)                                                                                                                      |
| 7   | Command-palette room row     | `RoomCommandItem.tsx:48`                        | via `RoomAvatar` (#12)                                                                                                                               |
| 8   | Sidebar agent list           | `AgentListItem.tsx:226` → `AgentIdentity`       | _via base_                                                                                                                                           |
| 9   | Sidebar "Recent" row         | `RecentSessionRow.tsx:45`                       | _via base_                                                                                                                                           |
| 10  | Sidebar room row (DM face)   | `RoomRow.tsx:330,367`                           | via `RoomAvatar` (#12)                                                                                                                               |
| 11  | Dashboard "Your agents" card | `AgentCard.tsx:30`                              | _via base_                                                                                                                                           |
| 12  | `RoomAvatar` DM face         | `entities/room/ui/RoomAvatar.tsx:97`            | **edit** — a DM counterpart is always an agent (`room-display.ts:104-108`); pass `kind="agent"` on the single and stacked faces                      |
| 13  | Chat status-line chip        | `AgentIdentityChip.tsx:68,79` → `AgentIdentity` | _via base_                                                                                                                                           |
| 14  | Room header masthead         | `RoomHeader.tsx:48`                             | via `RoomAvatar` (#12)                                                                                                                               |
| 15  | Room member sheet row        | `RoomMemberRow.tsx:185-194`                     | **edit** — replaced wholesale by the shared resolver (W1.4)                                                                                          |
| 16  | Room roster stack            | `MemberList.tsx:86-100`                         | **edit** — replaced wholesale by the shared resolver (W1.4)                                                                                          |
| 17  | Agent-add typeahead          | `AgentChipPicker.tsx:443-448`                   | **edit** — `kind="agent"` + explicit `badge={null}` (an agent-only list keeps the shape and drops the redundant glyph, deliberately and now visibly) |
| 18  | Approval requester           | `RequestingAgent.tsx:36-42`                     | **edit** — `kind="agent"`                                                                                                                            |
| 19  | First light / onboarding     | `FirstLight.tsx:47`                             | _via base_                                                                                                                                           |
| 20  | Agent Hub hero               | `AgentHubHero.tsx:211`                          | _via base_                                                                                                                                           |
| 21  | Agent settings Identity tab  | `IdentityTab.tsx:180-186` → `AgentIdentity`     | _via base_                                                                                                                                           |
| 22  | Execution-exceptions strip   | `ExecutionExceptionsStrip.tsx:108-112`          | _via base_                                                                                                                                           |
| 23  | Task scheduler picker        | `AgentPicker.tsx:53,97`                         | _via base_ (and merged in W1.5)                                                                                                                      |

Six files change; seventeen surfaces come along.

#### W1.4 One face resolver (merge candidate #2 — the sharpest violation)

`RoomMemberRow` and `MemberList` each hand-roll "prefer the agent's own manifest face, then the author
record's cached emoji/colour, then a letter", and disagree about the shape/badge decision. They cannot
share a component: `MemberList` is `entities/room` and the FSD rule forbids it importing
`entities/agent`. They can share a **pure function in `shared/lib`**, which takes only what a
presentational component reads:

```typescript
// apps/client/src/layers/shared/lib/identity-face.ts

/** Everything one identity disc needs, resolved once. */
export interface IdentityFace {
  kind: AuthorKind;
  color: string;
  emoji?: string;
  imageUrl?: string;
  /** The letter drawn when there is no image and no emoji. */
  fallback: string;
  origin?: IdentityOrigin;
}

/**
 * Resolve one identity's face from the fragments a caller happens to hold.
 *
 * Precedence, highest first: an explicit `override` (an agent's own manifest
 * colour/icon, which only a feature-layer caller can reach), then the author
 * record's render cache, then a colour hashed from the opaque id and the first
 * letter of the display name.
 *
 * Pure, layer-free and takes no agent types, which is the point: `MemberList`
 * lives in `entities/room` and may not import `entities/agent`, and that is
 * exactly why the two roster implementations diverged in the first place.
 */
export function resolveIdentityFace(input: IdentityFaceInput): IdentityFace;
```

`RoomMemberRow` (a feature) passes the `resolveAgentVisual()` override it already computes;
`MemberList` (an entity) passes none. Both then render one `IdentityAvatar` with `kind`, `working` and
the resolved face. The badge asymmetry — `Bot` in one file, external-only in the other — disappears
because neither file decides it any more.

#### W1.5 Remaining dedupes

**(#3) `AgentPicker` / `AgentCommandItem` single-select row.** Both are `Command`-based single-select
rows drawing avatar + name + secondary text off `resolveAgentVisual`. Extract
`entities/agent/ui/AgentOptionRow.tsx` — `{ agent, secondary?, trailing?, selected? }` — consumed by
`features/tasks/ui/AgentPicker.tsx:53` and `features/command-palette/ui/AgentCommandItem.tsx:71`. Both
are features and may import entities. **`AgentChipPicker` stays separate**: its multi-select keyboard
model is genuinely different and merging it would be coincidental-duplication extraction
(`.claude/rules/conventions.md`, DRY).

**(#4) `COLOR_PRESETS` and the picker grid.** Correction to the audit: `EMOJI_SET` is **already** shared
(`shared/lib/favicon-utils.ts:1`, barrel-exported at `shared/lib/index.ts:93`) and both pickers import it.
Only `COLOR_PRESETS` is duplicated, byte-identically, at `agent-settings/ui/IdentityTab.tsx:36-47` and
`agent-hub/ui/AvatarPickerPopover.tsx:12-23`. It moves to `shared/lib/favicon-utils.ts` beside
`EMOJI_SET` — splitting the two into separate homes would be the same mistake in a new file — and is
barrel-exported. The two swatch/emoji **grids** additionally collapse into one
`entities/agent/ui/AvatarPickerGrid.tsx`; the two _containers_ (an inline full-width panel with the
celebration animation vs. two `ResponsivePopover`s) stay, because they are genuinely different
surfaces.

**(#5 name collision) `SessionOriginMark`.** `entities/session/ui/OriginMark.tsx:34` renders _where a
session was started_; `entities/room/ui/OriginMark.tsx:46` renders _who a message came from_ — a
security-relevant "not from this machine" mark. Two entity modules, one name, one autocomplete away
from an import bug during this very consolidation. The session one is renamed:

| File                                                                 | Change                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| `entities/session/ui/OriginMark.tsx`                                 | → `SessionOriginMark.tsx`, export renamed            |
| `entities/session/ui/__tests__/OriginMark.test.tsx`                  | → `SessionOriginMark.test.tsx`, 5 assertions updated |
| `entities/session/index.ts:136`                                      | barrel export renamed                                |
| `entities/session/ui/SessionRowCompact.tsx:13,140`                   | import + JSX                                         |
| `entities/session/ui/SessionRowFull.tsx:25,257`                      | import + JSX                                         |
| `features/dashboard-sidebar/ui/RecentSessionRow.tsx:8,47`            | import + JSX                                         |
| `features/top-nav/ui/SessionHeader.tsx:4,47`                         | import + JSX                                         |
| `features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx:284` | mock key                                             |

The room `OriginMark` keeps its name — it is the one that matches the domain word used in
`AuthorOrigin`, `identity-origin.ts` and the chats-as-channels spec.

**(#7) Provenance-chip proliferation is NOT consolidated here.** Four components
(`OriginMark`×2, `AccountMark`, `RuntimeMark`) share an interaction shape and nothing else; a generic
`Mark` base would be an abstraction over a coincidence. Recorded as considered and declined.

#### W1.6 Managed-by: owner attribution (D2)

**`ownerId` is not added to `AgentManifest`, and that is the decision.** The manifest is the on-disk
source of truth (ADR-0043) and the mesh reconciler rebuilds `agents` from it every five minutes. An
owner id written into every `.dork/agent.json` would (a) be silently rebuilt from disk, (b) travel with
a project directory into someone else's checkout, and (c) claim a relationship the file has no way to
verify.

Owner attribution is **derived at read time**, exactly the way `TopologyAgentSchema`
(`packages/shared/src/mesh-schemas.ts:443-451`) already adds `healthStatus`, `taskCount` and `lastSeenAt`
— facts the manifest does not hold, computed when the fleet is read. It lives on the new roster payload
(§W2.2) as:

```typescript
/**
 * The person this identity belongs to, in this roster's own id space, or
 * `null` when nothing owns it (a person, the system voice).
 *
 * Semantically `CommunityMemberSchema.ownerMemberId` (community-adapter.ts:456-464)
 * — an agent admitted because its owner vouched for it — spelled in the ids
 * this payload uses. On a single-user install every locally-registered agent
 * resolves to the one operator; when a remote member's agents arrive, this is
 * filled from `ownerMemberId` and no shape changes.
 */
ownerId: z.string().nullable(),
```

**Render surfaces (all three ship in this program):**

1. **Team card** — `by @handle` under the agent's name, itself a control: clicking it filters the roster
   to that person and their agents (§W2.4).
2. **`IdentityHoverCard`** — a fourth chip in the existing agent chip row
   (`identity-hover-card.tsx:133-151`), reading `Managed by @handle`. The descriptor gains
   `agent.managedBy?: { displayName: string; handle: string | null }` — presentational, resolved by the
   caller, consistent with everything else on that descriptor.
3. **Profile drawer** — a labelled row in the agent's chip set (§W3.2).

`AgentHealthDetail.tsx:87-136` (the topology detail panel) is superseded as the "agent profile" surface
by the drawer and is **not** extended; §W2.5 says what happens to it.

#### Validation — W1

- **Structural:** a jsdom test renders `<IdentityAvatar kind="agent" />` and asserts the square radius
  class, the solid `backgroundColor` and a `Bot` badge; the same for `human` local (circle/tint/no
  badge), `human` external (platform glyph), `system`. A second test asserts explicit props override:
  `<IdentityAvatar kind="agent" shape="circle" />` is round, and `badge={null}` renders no plate.
- **The sweep is complete:** for each of the 23 rows above, a test or a rendered playground state shows
  an agent drawn square/filled/badged. Rows 4-11, 13, 19-23 are covered by the `AgentAvatar` unit test
  plus a lint-level assertion that `AgentAvatar`'s props type no longer admits `shape`/`variant`
  (a `@ts-expect-error` line in the test file — a compile-time check that cannot silently pass).
- **Face resolution is one implementation:** a unit table over `resolveIdentityFace` covering
  override-wins, cache-wins, hash-fallback, and the empty-display-name edge; plus jsdom tests asserting
  `RoomMemberRow` and `MemberList` render **the same** shape and badge for the same member — the
  regression that made this the sharpest violation.
- **`AgentAvatar` and `RoomMemberRow` draw no dot of their own** — grep-level: `bg-emerald-500` and
  `animate-ping` appear in `identity-avatar.tsx` and nowhere else under `layers/`.
- **`COLOR_PRESETS` is defined once** — grep returns exactly one definition.
- **No `OriginMark` name collision** — `grep -rn "export function OriginMark" apps/client/src` returns one.
- Browser: the room members sheet shows an agent and a human side by side, visibly different silhouettes.

---

### W2 — The Team page

#### W2.1 Route

`/team` replaces `/agents`, in `apps/client/src/router.tsx`.

```typescript
const teamRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/team',
  validateSearch: zodValidator(teamSearchSchema),
  component: TeamPage,
});
```

`teamSearchSchema` = `mergeDialogSearch(...)` over:

| Param     | Type                                                       | Default         | Notes                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`    | `'cards' \| 'table' \| 'topology' \| 'denied' \| 'access'` | `'cards'`       | `'list'` is accepted and normalized to `'table'` via a `z.preprocess`, because `/agents?view=list` is a live external address — the media-capture pipeline uses it at `apps/e2e/capture/surfaces-desktop.ts:48,498` |
| `kind`    | `'all' \| 'people' \| 'agents'`                            | `'all'`         | the filter chips                                                                                                                                                                                                    |
| `owner`   | `string` (member id)                                       | —               | filter to one person and their agents                                                                                                                                                                               |
| `group`   | `'none' \| 'manager'`                                      | `'none'`        | the group-by toggle                                                                                                                                                                                                 |
| `q`       | `string`                                                   | —               | search                                                                                                                                                                                                              |
| `member`  | `string`                                                   | —               | the selected identity — drives the profile drawer (§W3.2)                                                                                                                                                           |
| `agent`   | `string`                                                   | —               | retained: the topology detail-panel selection                                                                                                                                                                       |
| `sort`    | `string`                                                   | attention-order | retained from `agentsSearchSchema:128`                                                                                                                                                                              |
| _filters_ | —                                                          | —               | `agentFilterSchema.searchValidator` retained                                                                                                                                                                        |

**`/agents` survives as a redirect and nothing else.**

```typescript
const agentsAliasRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/agents',
  validateSearch: zodValidator(teamSearchSchema),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/team', search, replace: true });
  },
});
```

AGENTS.md says a superseded thing is removed, so the redirect needs its justification: **every
in-repo caller is swept to `/team` in the same change** (list below), and what the alias serves is
addresses this repo does not control — a bookmark, a docs link, and the Electron shell's persisted
tab list, which stores raw pathnames (`app/__tests__/use-electron-close-tab.test.tsx:57-126`). A
persisted tab pointing at a dead route is a blank window on next launch. The alias is one `beforeLoad`
line with a test, not a parallel implementation.

**In-repo call sites swept to `/team`** (13 non-test + the tests that pin them):

`features/mesh/ui/ImportProjectsDialog.tsx:59` · `features/settings/ui/external-mcp/ExternalMcpCard.tsx:201` ·
`features/feature-promos/ui/dialogs/AgentChatDialog.tsx:12` · `features/dashboard-sidebar/ui/SidebarNavHeader.tsx:53-54` ·
`features/command-palette/model/use-palette-actions.ts:124,199` · `features/top-nav/ui/AgentsHeader.tsx:35` ·
`features/dashboard-status/ui/SystemStatusRow.tsx:91` · `widgets/agents/ui/AgentsPage.tsx:123,136,150,161,183` ·
`AppShell.tsx:190` (`case '/agents'` → `case '/team'`) · `apps/e2e/capture/surfaces-desktop.ts:48,55,379,498,713` ·
`apps/e2e/tests/agents/agents-page.spec.ts` (+ its `apps/e2e/manifest.json:341` entry).

**Nav.** `SidebarNavHeader.tsx:50-56` — label `Agents` → `Team`, icon `Users` (unchanged, and now
literally right), `isActive` on `/team`, `to: '/team'`. `TOUR_ANCHORS.navAgents` keeps its key (renaming a
tour anchor breaks the persisted tour position for no user gain) and gains a comment saying why.

**`?view=topology` stays**, reached from the Team page's view switch rather than a separate concept —
it is the one view that is genuinely agent-only, and the switch labels it so. The topology graph,
`AgentNode`, the access/denied states and `AgentGhostRows` are all reused unchanged from
`widgets/agents/`; only the page shell and the two identity-bearing views are new.

#### W2.2 Server — one read-only aggregation

**Route:** `GET /api/team` — `apps/server/src/routes/team.ts`, mounted in `apps/server/src/index.ts`
beside the other injected-singleton routers (it needs `meshCore`, the `AuthorRegistry` and the db).

**Service:** `apps/server/src/services/identity/aggregate-team.ts`. A new `services/identity/` domain is
justified under `.claude/rules/server-structure.md` ("a cohesive area with a clear boundary", never a
single orphan file): it holds `aggregate-team.ts`, `operator-profile.ts`, `avatar-store.ts` and
`local-avatar-store.ts` (§W3.5) — "who is on this install, and what they look like". It belongs to
neither `rooms/` nor `mesh/` because it reads both.

**Response envelope, modelled exactly on ADR-0310** (`routes/sessions.ts:80-91`,
`aggregate-session-list.ts:99-142`):

```typescript
// packages/shared/src/team-schemas.ts

/**
 * One identity source that could not be read. Same instrument as
 * `SessionListWarningSchema` (schemas.ts:597-615) and for the same reason: a
 * degradation invisible to the Direct transport is a degradation nobody sees,
 * so it travels in-band rather than in a header.
 */
export const TeamSourceWarningSchema = z
  .object({
    /** `'authors'`, `'agents'`, or a community ref once remote sources exist. */
    source: z.string().min(1),
    message: z.string().min(1),
  })
  .openapi('TeamSourceWarning');

export const TeamRosterResponseSchema = z
  .object({
    members: z.array(TeamMemberSchema),
    /** Omitted entirely when every source read cleanly — never `[]`. */
    warnings: z.array(TeamSourceWarningSchema).optional(),
  })
  .openapi('TeamRosterResponse');
```

```typescript
export const TeamMemberSchema = z
  .object({
    /** Opaque roster id: the author id for a person, the manifest id for an agent. */
    id: z.string().min(1),
    kind: AuthorKindSchema, // reused, never forked
    displayName: z.string().min(1),
    /** From `authors.handle` (DOR-676). `null` = this identity cannot be addressed. */
    handle: z.string().nullable(),
    emoji: z.string().optional(), // render cache
    color: z.string().optional(), // render cache
    imageUrl: z.string().optional(), // render cache — the fourth field (§W3.5)
    /** True for exactly one row: the operator reading this. */
    isSelf: z.boolean(),
    /** Owner attribution — see W1.6. */
    ownerId: z.string().nullable(),
    origin: AuthorOriginSchema, // 'local' | { platform }
    agent: TeamAgentFactsSchema.optional(), // kind === 'agent' only
    person: TeamPersonFactsSchema.optional(), // kind === 'human' only
  })
  .openapi('TeamMember');

const TeamAgentFactsSchema = z.object({
  manifestId: z.string(),
  runtime: AgentRuntimeSchema,
  model: z.string().optional(),
  healthStatus: AgentHealthStatusSchema,
  working: z.boolean(),
  namespace: z.string().optional(),
  projectPath: z.string().optional(),
  isDefault: z.boolean(),
  isSystem: z.boolean(),
  registeredAt: z.string(),
});

const TeamPersonFactsSchema = z.object({
  /** Backend-declared, `null` where a backend has no roles — as `CommunityMember.role`. */
  role: z.string().nullable(),
  /**
   * Present ONLY on the viewer's own row. Never carried for anyone else, even
   * on a single-user install: the shape has to be right before there is a
   * second person to leak it to.
   */
  email: z.string().optional(),
});
```

**Aggregation, source by source:**

1. **People** — `authors` where `retired_at IS NULL` and `kind = 'human'`. `AuthorRegistry` has **no**
   list method today (verified: `getById` at `:614` and `getMany` at `:626` are the only reads), so it
   gains one — `listActive(kind?: AuthorKind): AuthorRecord[]`, following the existing `activeRow`
   query shape (`:348`).
2. **Agents** — `meshCore.listWithHealth(...)`, the same read `GET /api/mesh/agents`
   (`routes/mesh.ts:376-385`) already uses. No new mesh query.
3. **The operator's identity** — `operator-profile.ts` resolves it with an **explicit precedence that
   never depends on `authors.display_name`**:
   `findOwnerAccount()?.name` (`accounts.ts:45-54`) → `config.profile.displayName`
   (`UserProfileSchema`) → the author record's `displayName` → `'You'`.
   The stored `LOCAL_HUMAN_DISPLAY_NAME = 'You'` (`author-registry.ts:74`) is **not changed** and
   `bindOwner` (`:553`) is **not touched**. This is the answer to the user-model audit's open question
   (e)1: the two contexts diverge rather than fight. A room renders `'You'` because that is the right
   word from the operator's own seat; a roster has no "you" framing and renders the real name, with a
   small **"you"** chip on the self card doing the job the literal used to.
4. **`ownerId`** — every non-system agent read from the local mesh gets the operator's roster id. A
   system agent (`isSystem`, i.e. DorkBot) gets `null`: it belongs to the install, not to a person.
5. **Degradation** — each source is read in its own `try`/`catch` with the same 2s timeout constant
   `aggregate-session-list.ts:25` uses; a failure pushes `{ source, message }` and the other sources
   still return. A total failure of one source is a degraded roster, never a 500.

**OpenAPI.** A `registry.registerPath` entry in
`apps/server/src/services/core/openapi-registry.ts` whose `description` cites the degradation
contract, matching the `/api/sessions` entry at `:362-384`.

**What this endpoint is not:** it writes nothing, it mints nothing, it has no `POST`, and it creates no
row. Every id it returns already existed in `authors` or `agents`. That is ADR `260806-222535`.

#### W2.3 Client data

`entities/team/` — a new entity slice: `api/` (transport call), `model/use-team-roster.ts` (TanStack
Query, keyed `['team']`), and the derived selectors the page needs. `entities/` is correct: the roster
is a domain object several features and one widget read, and it must not live in the widget that
happens to render it first.

#### W2.4 The page

`widgets/team/ui/TeamPage.tsx` — a widget, per the FSD rule, because it composes several features.
Cards, chips, the group toggle and the view switch are feature-layer components under
`features/team-roster/`; the identity primitives they use stay in `shared/` and `entities/`.

**Cards view (default).** One unified grid, operator first, then agents — chosen over a sectioned
roster (design record §2, click `team-b-unified`) because the shape/badge language does the
distinguishing and sections would say the same thing twice. Each card carries: the identity disc at
`md`, display name, `@handle`, a kind-specific second line (agent: `runtime · model`; person:
`role` or `On this machine`), a working dot when live, and — on an agent — **`by @handle`** owner
attribution rendered as a button.

**Filter chips.** `All · People · Agents`, then one chip per person once more than one exists (on a
single-user install the person chips collapse into the owner filter, which is reached by clicking a
card or an attribution). Chips write `?kind=` / `?owner=`, so a filtered roster is a shareable URL.

**Group: manager toggle.** `?group=manager` re-clusters agent cards under a header row for each owner
(the person's own compact lockup), with unowned identities last. D1b makes person a first-class view
axis, which is why `ownerId` is required on the payload from day one rather than derived in the client
from something else.

**Search** (`?q=`) matches display name and handle, case-insensitively, over the already-loaded roster
— no server round trip, because the roster is bounded by the agents on one machine.

**Table view.** Seeded from `features/agents-list/lib/agent-columns.tsx`. Its `IdentityCell` (`:73-108`)
becomes kind-aware (it inherits the fix through `AgentAvatar`), and the table gains a **Managed by**
column. People rows render with the columns that apply and blanks where they do not — a person has no
runtime.

**Mobile.** The grid is one column below `md` (768px, the same breakpoint everything else in this
cockpit turns on — `use-is-mobile.ts:3`, `agent-columns.tsx` responsive notes). The chip row scrolls
horizontally rather than wrapping to three lines. The view switch drops the table option below `md`
(a 6-column table on a phone is not a view), leaving cards and topology.

**Empty and degraded states.** `AgentGhostRows` is reused for the no-agents state, now with the
operator's own card above it — the roster is never empty, because the person reading it is on it.
When `warnings` is present, a dismissible inline banner names the source that failed
(`"Couldn't read your agents — showing who we could."`), written to the `writing-for-humans` bar.

#### W2.5 What happens to the old surfaces

- `widgets/agents/ui/AgentsPage.tsx` is **deleted**; its topology/denied/access branches move into
  `TeamPage`. No parallel page survives.
- `features/agents-list/` keeps `AgentsList`, `AgentGhostRows`, `DeniedView`, `AccessView` and
  `agent-columns.tsx` — all still used, now by `TeamPage`.
- `features/mesh/ui/AgentHealthDetail.tsx` **stays** as the topology-node detail panel (it is about
  mesh health, not identity) and is **not** grown into a profile. Its "open profile" affordance opens
  the drawer (§W3.2), so there is exactly one profile surface.
- `features/top-nav/ui/AgentsHeader.tsx` → `TeamHeader.tsx`, with the view switch gaining Cards.

#### W2.6 Buzz groundwork — the constraint, and its limit

`TeamMemberSchema` is already the shape a remote member arrives in: opaque `id`, `kind`, render cache,
`origin`, `ownerId`. Two rules bind the card and roster components so remote membership needs no
rework:

1. **No component may branch on "there is exactly one person."** Rendering, grouping and filtering read
   the roster as a list. A test asserts the card grid and the manager grouping render correctly for a
   fixture with two people, four agents and two owners — a shape the product cannot produce yet, which
   is precisely why the test exists.
2. **No component may assume `isSelf` for a person.** `isSelf` is a flag on one row; "you" is a chip,
   not a code path.

Building remote membership — admission, transport, presence — is **out of scope**.

#### Validation — W2

- **Endpoint:** a server test asserts the roster contains one `kind: 'human'` row with `isSelf: true`,
  one row per registered agent, `ownerId` equal to the operator's id on every non-system agent and
  `null` on DorkBot, and `warnings` **absent** on a clean read. A second test stubs the mesh read to
  throw and asserts the people rows still return with `warnings: [{ source: 'agents', … }]` and HTTP 200.
- **The literal is gone:** a test with an owner account named `Dorian` asserts the roster returns
  `Dorian`, not `You`; and a room roster read in the same test still renders `You`. Both halves, or the
  divergence is not pinned.
- **Routing:** navigating to `/agents?view=list&sort=x` lands on `/team?view=table&sort=x` with
  `replace: true`; `/agents?view=topology` lands on `/team?view=topology`.
- **Browser (`apps/e2e`):** on `/team` — the operator's card renders first with a circle disc; an agent
  card renders a square, filled disc with a `Bot` badge and a `by @handle` line; clicking `Agents`
  hides the person card; clicking an attribution filters to that owner and the URL carries `?owner=`;
  `Group: manager` produces one cluster header; the view switch reaches the table and the topology; a
  reload of the filtered URL restores the same view.
- **Mobile browser (375px):** cards are one column, chips scroll, the table option is absent.

---

### W3 — Profile & account surfacing

#### W3.1 The account menu in the chrome

**Placement, read from the current shell.** The app shell is `apps/client/src/AppShell.tsx:255`
(the `_shell` layout route, `router.tsx:55-77`). Its sidebar footer is static at `:478-492` and renders
`ProgressCard`, `ProfilePromptCard` and `SidebarFooterBar`
(`features/session-list/ui/SidebarFooterBar.tsx:45`), whose layout is: a `DorkLogo` brand link on the
left (`:163-170`), a right-hand icon cluster (`:171-290` — the tunnel globe, the extension-contributed
`sidebar.footer` buttons, `HelpMenu`), and a version row beneath (`:293-333`). **There is no user or
account element anywhere in the shell today** (verified by grep).

The account button becomes the **first item in that right-hand icon cluster**, at `:172`, left of the
tunnel globe. It is icon-sized — the operator's `IdentityAvatar` at `size="sm"` — so it sits in a row of
peers without re-laying-out the footer, and it does not displace the brand link, which is a different
affordance. It is a `ResponsiveDropdownMenu` (`shared/ui/responsive-dropdown-menu.tsx:34`), which gives
the mobile behaviour for free: a bottom drawer on a phone, a dropdown on a pointer.

**Menu contents**, in order: a header block (avatar, display name, `@handle`); `View profile` (opens
the drawer on the operator's own row); `Settings` (calls the existing `useSettingsDeepLink().open()`,
already wired at `SidebarFooterBar.tsx:53`); `Sign out`, rendered **only when a local account exists**
(`useCurrentUser()` non-null — `features/auth/model/use-auth-session.ts:146-149`), because login is
optional and off by default (ADR-0320) and a sign-out button on an install with no account is a
control that does nothing.

**Known verification point:** on mobile the sidebar is itself a `Sheet` (`shared/ui/sidebar.tsx:179-201`),
so this opens a vaul `Drawer` inside a Radix `Dialog`. That composition is not used anywhere in the app
today. It gets an explicit browser check (§Validation), and the fallback if it misbehaves is the same
`ResponsiveDropdownMenu` forced to its dropdown branch inside the sheet.

#### W3.2 The profile drawer — one component, any identity

**A new shared primitive first.** There is no desktop-right-drawer / mobile-full-screen primitive in
`shared/ui/`: every `Responsive*` component there pairs a desktop overlay with a **bottom** vaul drawer
(`responsive-dialog.tsx:54`, `responsive-popover.tsx:63`, `responsive-dropdown-menu.tsx:34`,
`responsive-context-menu.tsx:33`), and the right-side behaviour is hand-rolled twice — in
`RightPanelContainer.tsx:199-216` and again in `sidebar.tsx:179-201`. This spec adds the third-use
extraction the DRY rule asks for:

```
apps/client/src/layers/shared/ui/responsive-sheet.tsx
  ResponsiveSheet / ResponsiveSheetContent / …
  desktop: <Sheet><SheetContent side="right" className="sm:max-w-md">
  mobile : <Sheet><SheetContent side="right" className="w-full sm:max-w-full">
  switch : useIsMobile()  (768px — shared/model/media/use-is-mobile.ts:3)
```

Generalized from `RightPanelContainer.tsx:199-216`, which then consumes it rather than keeping its own copy.

**The drawer.** `features/profile/ui/ProfileDrawer.tsx` renders **any** `TeamMember`:

| Section | Agent                                                                  | Person                                        |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Header  | disc (square/fill/`Bot`) · display name · `@handle`                    | disc (circle/tint) · display name · `@handle` |
| Chips   | `runtime · model` · working state · **managed by @handle**             | role · origin (`On this machine` / platform)  |
| Body    | project path, namespace, health, registered-at, default/system markers | joined-at; email **only on your own row**     |
| Actions | Open a session · Agent settings                                        | **Edit** (own row only) → Settings › Profile  |

Same descriptor family as `IdentityHoverCard` on purpose: the card is the glance, the drawer is the
look. One component, both kinds, no per-kind subclass.

**Opening it, from everywhere.** State is a URL param so a profile is shareable and the phone's back
gesture dismisses it: `dialogSearchSchema` (`shared/model/dialog-search-schema.ts:17-30`) gains
`profile: z.string().optional()`, and a `useProfileDeepLink()` hook follows
`use-dialog-deep-link.ts:154-235` exactly (open/close/set, dual-signal with a store flag, no-op fallback
when there is no router — which is how this keeps working in the Obsidian embed). The drawer is
registered as a `DialogContribution`
(`widgets/app-layout/model/dialog-contributions.ts`) beside Settings, so it mounts once in `DialogHost`
(`AppShell.tsx:582`) and is reachable from every route.

**Wiring the deferred affordance.** `IdentityHoverCard`'s footer currently reads
`View profile` + a muted `soon` (`identity-hover-card.tsx:~155-160`). It gains
`onViewProfile?: () => void`; when supplied the footer becomes a real control and the `soon` tag goes.
The prop, not an import, is what keeps the primitive in `shared/` — a `shared/ui` component may not
reach a feature. Callers that wire it: `widgets/room-view/ui/MentionPillRenderer.tsx:66` (the only live
hover card today), the Team cards, the sidebar agent list, and the chat status-line chip.

**DOR-950's click-to-profile is absorbed here**: a click on a mention pill or an identity avatar in a
room opens the drawer, which is the destination that ticket was waiting for.

#### W3.3 Settings › Profile

`SETTINGS_TABS` (`features/settings/ui/SettingsDialog.tsx:27-74`) gains, **as the first entry**:

```typescript
{ id: 'profile', label: 'Profile', icon: UserRound, component: ProfileTab },
```

"Promoted to the top" needs nothing else: ungrouped tabs render above the first group header
(`shared/ui/tabbed-dialog.tsx:123-131`), and `appearance`/`preferences` are the only other ungrouped
tabs. `SettingsTab` (`shared/model/app-store/app-store-panels.ts:16-26`) gains `'profile'`. The tab is
reachable at `?settings=profile` through the existing deep-link machinery, which is what the drawer's
**Edit** button calls: `useSettingsDeepLink().open('profile')`.

**The form**, top to bottom:

| Field        | Writes to                                                                       | Notes                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photo        | `POST /api/profile/avatar` (§W3.5)                                              | drop or pick; initials preview; **Remove** clears it                                                                                                                   |
| Display name | the operator's author record + Better Auth `user.name`                          |                                                                                                                                                                        |
| `@handle`    | `PATCH /api/rooms/authors/:id/handle` — **the handles spec's route, unchanged** | its three typed refusals (`HANDLE_TAKEN`, `HANDLE_RESERVED`, `INVALID_HANDLE`) map to three different messages, because they are three different things to do about it |
| Email        | read-only, from the local account                                               | with a line saying login is optional and where to turn it on                                                                                                           |

Settings is a `TabbedDialog` over `ResponsiveDialog`, so **mobile is already solved**: the whole dialog
is a bottom vaul drawer below 768px (`responsive-dialog.tsx:60-62`). The photo control must be reachable
inside it — verified in the browser, not assumed.

Settings › Security keeps its login toggle and sign-out; it loses nothing. What changes is that identity
is no longer _only_ there.

#### W3.4 `imageUrl` — the fourth render-cache field

`displayName` + `emoji` + `color` is the render-cache triplet the whole cockpit speaks. A photo is a
**fourth optional field beside them**, not a replacement and not a new system — the same additive move
`responseMode` made on `CommunityMemberSchema`. Every touch point, enumerated so none is missed:

| #   | File                                                                                                 | Change                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `packages/db/src/schema/rooms.ts` `authors` (`:43-103`)                                              | `imageUrl: text('image_url')` + generated migration                                                                                                                                                                                        |
| 2   | `packages/shared/src/room-schemas.ts` `AuthorRefSchema` (`:219-245`)                                 | `imageUrl: z.string().optional()` — render cache, described as such                                                                                                                                                                        |
| 3   | `packages/shared/src/community-adapter.ts` `CommunityMemberSchema` (`:435-467`)                      | `imageUrl` beside `emoji`/`color`                                                                                                                                                                                                          |
| 4   | `packages/shared/src/team-schemas.ts` `TeamMemberSchema`                                             | present from the first commit                                                                                                                                                                                                              |
| 5   | `apps/client/.../shared/ui/identity-avatar.tsx`                                                      | `imageUrl?: string`; render precedence **image → emoji → fallback letter**; the image is `object-cover`, inherits the disc's `shape` radius, and carries `alt=""` because the disc is decorative and the row's own text names the identity |
| 6   | `shared/ui/identity-hover-card.tsx` `IdentityHoverCardDescriptor`                                    | `imageUrl?`                                                                                                                                                                                                                                |
| 7   | `shared/ui/mention-pill.tsx`                                                                         | **no change** — a pill carries a glyph, not a photo                                                                                                                                                                                        |
| 8   | `shared/lib/identity-face.ts` (new, W1.4)                                                            | `imageUrl` in input and output                                                                                                                                                                                                             |
| 9   | `features/chat/lib/resolve-message-author.ts:84`                                                     | `MessageAuthor.imageUrl?`, passed to `MessageAuthorAvatar`                                                                                                                                                                                 |
| 10  | `entities/agent/ui/AgentAvatar.tsx` + `AgentIdentity.tsx`                                            | pass-through                                                                                                                                                                                                                               |
| 11  | `entities/room/ui/RoomAvatar.tsx`, `MemberList.tsx`; `features/room-management/ui/RoomMemberRow.tsx` | via the shared resolver                                                                                                                                                                                                                    |
| 12  | `apps/server/src/services/rooms/author-registry.ts`                                                  | `imageUrl` joins `displayName`/`emoji`/`color` in the refresh-on-resolve set (it is a cache, so it refreshes — unlike `handle`, which D12 of the handles spec forbids refreshing)                                                          |
| 13  | `packages/db/src/schema/auth.ts` `user.image`                                                        | **no schema change** — the column exists and is finally written                                                                                                                                                                            |
| 14  | `apps/client/src/dev/mock-samples.ts` `MockIdentity` (`:792-800`)                                    | `imageUrl?` + at least one cast member carrying one                                                                                                                                                                                        |

The **upload UI is for people only** (Settings › Profile). Agents keep emoji + colour, which is their
identity language and which DOR-949 is separately about seeding. The field is on the shared cache so an
agent could carry one later without a schema change.

#### W3.5 Avatar storage — local, with a sync-ready seam

**The seam is the requirement** (D5, Dorian explicit). The route depends on an interface, never on the
disk:

```typescript
// apps/server/src/services/identity/avatar-store.ts

/**
 * Where an identity's photo lives.
 *
 * `put` returns the URL a render cache stores — and that is the whole seam.
 * `imageUrl` is source-agnostic by construction: today `LocalAvatarStore`
 * returns a server-relative `/api/profile/avatar/<id>?v=<hash>`; a future
 * server- or cloud-backed store returns an absolute `https://…` and not one
 * renderer, schema or component changes. Nothing above this interface may
 * construct a path, join a directory, or assume the bytes are local.
 */
export interface AvatarStore {
  put(id: string, bytes: Buffer, contentType: AvatarContentType): Promise<{ url: string }>;
  get(id: string): Promise<{ stream: Readable; contentType: string; etag: string } | null>;
  delete(id: string): Promise<void>;
}
```

`LocalAvatarStore` (`local-avatar-store.ts`) is the only implementation today. It writes
`<dorkHome>/avatars/<authorId>.<ext>` where `dorkHome` comes from `resolveDorkHome()`
(`lib/dork-home.ts:15-21`) — **never `os.homedir()`**, which is banned in `apps/server/src` outside the
three carve-outs (Hard Rule 3, `.claude/rules/dork-home.md`). Note this is deliberately **not** the
existing upload directory: `UploadHandler.getUploadDir(cwd)`
(`services/core/upload-handler.ts:28`) is `{cwd}/.dork/.temp/uploads` — per-project and temporary. An
avatar is per-install and permanent.

**`POST /api/profile/avatar`** — multipart, using a **dedicated** multer instance in
`routes/profile.ts` (the existing one in `routes/uploads.ts:19-67` is cwd-scoped and config-driven; it is
not reusable here). Rules:

- **≤ 2 MB**, enforced by multer `limits` before a byte is written.
- **png / jpeg / webp only, validated by magic bytes**, not by the extension or the `Content-Type` the
  client claims. **SVG is refused** — it is a script vector, and `files.ts:109-116` needs a bespoke CSP
  header to serve one safely; a profile photo has no reason to be one.
- **No re-encoding, no resizing.** That needs `sharp` or equivalent, and this spec adds no dependency
  (§Non-Goals). The 2 MB cap plus a `max-w` on the render is the bound.
- Writes go through the store, then update `authors.image_url` **and** Better Auth `user.image` with the
  same URL, so the account record and the roster cannot disagree.
- `DELETE /api/profile/avatar` clears all three.

**`GET /api/profile/avatar/:id`** — modelled on `routes/files.ts:49-135`: `createReadStream(...).pipe(res)`,
`Content-Type` from the stored type, **`X-Content-Type-Options: nosniff`**, a strong `ETag` from the
content hash and `Cache-Control: private, max-age=0, must-revalidate`. The `?v=<hash>` in `imageUrl` is
what makes a replaced photo appear immediately without disabling caching.

#### W3.6 Two accounts, one shown

The local Better Auth instance (`apps/server`, SQLite, `services/core/auth/index.ts:83`) and the
dorkos.ai cloud instance (`apps/site`, Postgres) are **two independent records for the same person**
(user-model audit §e.3). This spec resolves only what it must:

> **The identity shown everywhere in the cockpit is the local one.** The Settings › "DorkOS account"
> tab (`features/settings/ui/CloudAccountTab.tsx`) stays exactly as it is — a device-link flow for
> analytics linking and update notifications — and the Profile tab neither reads from it, writes to it,
> nor implies they are the same account.

No cloud avatar is fetched, no name is synced, no reconciliation is attempted. Reconciling the two is
DOR-605's problem; **not conflicting with it** is this spec's.

#### Validation — W3

- **Upload roundtrip:** a server test posts a 1×1 PNG, asserts a file lands under
  `<dorkHome>/avatars/`, that the response `url` round-trips through `GET` with the right
  `Content-Type` and `nosniff`, that `authors.image_url` and `user.image` both hold it, and that
  `DELETE` clears all three. Negative cases that must **fail**: a 3 MB file (413/400), an SVG, and a
  `.png` whose magic bytes say GIF.
- **The seam holds:** a test substitutes a fake `AvatarStore` returning `https://cdn.example/x.png` and
  asserts the roster's `imageUrl` is that absolute URL with no route, schema or client change — the
  assertion that the sync-ready claim is true rather than asserted.
- **`os.homedir()` appears nowhere new** — `scripts/test-homedir-guard.sh` already pins this; the new
  files must pass it.
- **Render precedence:** a jsdom test on `IdentityAvatar` — with `imageUrl` an `<img>` renders and the
  emoji does not; without it the emoji renders; without both, the letter.
- **Drawer:** jsdom tests render an agent member (square disc, runtime chip, managed-by chip) and a
  person member (circle disc, origin chip, Edit only on `isSelf`).
- **Browser, desktop:** clicking a Team card opens a right drawer, the URL carries `?profile=`, reload
  reopens it, Edit lands on Settings with the Profile tab active; the account menu opens from the
  sidebar footer and shows name + `@handle`.
- **Browser, mobile (375px):** the drawer is full-screen; the account menu opens from **inside the
  sidebar sheet** (the vaul-in-Radix composition named in §W3.1) and is dismissible; Settings ›
  Profile's photo control is reachable in the bottom drawer.

---

### W4 — The playground Identity page

#### W4.1 Registration — seven touch points, not six

The audit lists six (§d.1). There is a **seventh**, and missing it turns the drift test red in CI:

| #   | Touch point                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `dev/playground-registry.ts:2-22` — `'identity'` in the `Page` union                                                                                                                                                                         |
| 2   | `dev/sections/identity-sections.ts` — **new**, exporting `IDENTITY_SECTIONS`                                                                                                                                                                 |
| 3   | `dev/playground-registry.ts:38-56` (named re-export) **and** `:59-104` (aliased import + spread into `PLAYGROUND_REGISTRY`)                                                                                                                  |
| 4   | `dev/playground-config.ts` — import + a `PageConfig` entry (`id: 'identity'`, `group: 'agents'`, `path: 'identity'`, icon, description)                                                                                                      |
| 5   | `dev/pages/IdentityPage.tsx` — **new**, via `PlaygroundPageLayout`                                                                                                                                                                           |
| 6   | `dev/DevPlayground.tsx:88-109` — `PAGE_COMPONENTS` entry + import                                                                                                                                                                            |
| 7   | **`dev/__tests__/playground-registry.test.ts:5-26` and `:51-71`** — the union assertion hardcodes all 19 section arrays by name. Without `IDENTITY_SECTIONS` there, _"PLAYGROUND_REGISTRY equals the union of all page-level arrays"_ fails. |

Placement is the **Agents** group (D6), beside Subsystems and Rooms.

#### W4.2 Cross-listing, against the drift test's actual mechanics

The registry enforces `id === slugify(title)` (`playground-registry.test.ts:78-82`) **and** no duplicate
ids across the whole registry (`:31-34`). Together those mean **one title holds exactly one registry
entry**, which pins it to exactly one `page` (its ⌘K group) and one `/dev/<page>#<anchor>` URL. So
"cross-listed" cannot mean two entries. It means:

**Cross-listing is by rendering, not by double-registration.**

1. The three `shared/ui` primitives — `IdentityAvatar` (`components-sections.ts:248-267`), `MentionPill`
   (`:268-287`), `IdentityHoverCard` (`:288-304`) — **keep `page: 'components'`, their ids, their titles
   and their existing `/dev/components#…` anchors**. Nothing moves; no saved link breaks, which is the
   constraint the audit named (§d.3).
2. `IdentityPage.tsx` **imports and renders those same showcase components**. The drift check scans
   **files** (`readRenderedSections()`, `:154-167`, walks `dev/showcases/*.tsx` and `dev/pages/*.tsx`), so a
   second page rendering an already-registered showcase adds no new rendered title and both drift
   directions stay green.
3. The Identity page's TOC is nevertheless complete, because `PageConfig.sections` is **composed**:

   ```typescript
   sections: [...IDENTITY_SECTIONS, ...COMPONENTS_SECTIONS.filter((s) => IDENTITY_PRIMITIVE_IDS.has(s.id))],
   ```

   This is legal against every assertion: `PLAYGROUND_REGISTRY` is the union of the per-page
   `*_SECTIONS` arrays (`:50-72`) — **not** of `PAGE_CONFIGS[].sections` — and
   _"every page with sections has those sections in PLAYGROUND_REGISTRY"_ (`:110-116`) only asserts
   containment, which holds because each borrowed entry is in the registry exactly once.

4. **The accepted cost, stated rather than discovered:** those three sections still group under
   "Components" in ⌘K and their canonical URL stays `/dev/components#identityavatar`. That is the trade
   for not breaking a single existing anchor.

**Sections that genuinely move** (their entry moves from one array to another and its `page` changes,
so their anchor changes): `AgentAvatar` and `AgentIdentity`, `features-sections.ts:26-40` → Identity.
They are entity-layer identity components, "Subsystems" is not where anyone looks for them, and nothing
outside this repo links to a playground anchor. `RoomMemberRow` (`rooms-sections.ts:33-37`),
`MessageAuthorAvatar` (`chat-sections.ts:40-59`) and `AgentIdentityChip` (`chat-sections.ts:567-582`)
**stay registered where they are** and are cross-listed by rendering, per the rule above — each is
primarily a room or chat surface.

#### W4.3 New coverage

The four components with zero playground coverage today, plus what this program adds:

| Section (new)           | Renders                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `RoomAvatar`            | channel `#` glyph, single DM face, stacked faces, letter fallback — now kind-aware                                                            |
| `AvatarPickerGrid`      | the unified colour/emoji grid (W1.5), in both its containers                                                                                  |
| `RoomPresenceLine`      | the room's live working line                                                                                                                  |
| `Identity Shape Matrix` | agent × human-local × human-external × system, crossed with image / emoji / letter — the whole convention on one screen                       |
| `Identity Sizes`        | every kind at `xs`/`sm`/`md`/`lg` — **external: in progress as DOR-955**, so W4 composes it in if it has landed and never builds a second one |
| `Account Menu`          | the chrome menu (W3.1), open                                                                                                                  |
| `Profile Drawer`        | agent and person, desktop and mobile widths                                                                                                   |
| `Team Card`             | operator, agent-with-owner, external person, long name/handle                                                                                 |

`AgentChipContextMenu`'s open state and `identity-origin` states ride along in the existing
`AgentIdentityChip` and matrix sections.

#### W4.4 Mock data and the `category` correction

`AgentIdentityShowcases.tsx:7-18` uses its own inline `SAMPLE`/`AGENTS` consts. They are **deleted**;
every identity showcase draws from `MOCK_IDENTITIES` (`dev/mock-samples.ts:809-872`), which is extended
with `imageUrl`, `ownerHandle` and `working` on `MockIdentity` (`:792-800`) and gains a cast member
carrying a photo (a small inline data URI, so the playground needs no network and no fixture file).

**`category` is dead metadata** and the audit is right that it must stop being treated as a grouping
mechanism: nothing reads `.category` anywhere (`PlaygroundSearch.tsx:18-25,63-79` groups by
`section.page`; `TocSidebar` renders flat). It is **kept** — it is data on 241 entries used as in-file
documentation, and churning all of them buys no user anything — but two things change so it stops
lying:

1. Its TSDoc in `playground-registry.ts` is corrected to say it is documentation-only, not a search
   grouping.
2. `.claude/skills/maintaining-dev-playground/SKILL.md`'s claim that it _"controls search grouping in
   Cmd+K results"_ is corrected, since that sentence is what would otherwise make the next author
   build on it.

No new code may branch on `category`.

#### Validation — W4

- `pnpm vitest run apps/client/src/dev/__tests__/playground-registry.test.ts` is **green** — which now
  transitively proves: `IDENTITY_SECTIONS` is in the union, every new `<PlaygroundSection>` has a
  literal title and a registry entry, every registry entry has a rendered anchor, no duplicate ids, and
  every id is `slugify(title)`.
- `/dev/components#identityavatar`, `#mentionpill` and `#identityhovercard` still resolve.
- `/dev/identity` renders every section in its TOC, including the three cross-listed ones.
- Every state in `MOCK_IDENTITIES` renders on the Identity page; `grep -n "SAMPLE\|const AGENTS" dev/showcases/AgentIdentityShowcases.tsx` returns nothing.

---

## User Experience

**Opening the roster.** The sidebar's third nav row reads **Team**. It opens a grid of cards: you first —
your photo or your initial, your name, your `@handle` — then every agent on this machine, each a square
tile in its own colour with a small robot mark, and under each one, _by @you_.

**Finding someone.** Three chips across the top: All, People, Agents. Type to search. Tap a person and
the roster narrows to them and their agents. Flip **Group: manager** and the agents cluster under the
person they belong to. Switch to the table when you want columns, or to the map when you want to see
how they connect. Everything you picked is in the URL, so the view survives a reload and can be sent to
someone else.

**Looking someone up.** Click any face, anywhere — a card, a message, a mention — and a panel slides in
from the right with the whole picture: name, handle, what runtime and model an agent runs, whether it is
working right now, who it belongs to. On a phone the same panel fills the screen and the back gesture
closes it.

**Being someone.** Your avatar sits in the bottom-left of the sidebar. Click it for your name, your
handle, **View profile**, **Settings**, and **Sign out** when you have an account. Editing lives in
Settings › **Profile**, now the first tab: drop in a photo, set your name, claim your `@handle`. If the
handle is taken the form says which of the three things went wrong rather than quietly keeping the old
one.

**When something is missing.** No photo falls back to your emoji, then to your initial — the disc is
never empty. If DorkOS cannot read your agents, the roster still shows the people it knows and says
plainly what it could not load. An agent with no handle shows no `@` at all, rather than one that
reaches nobody.

---

## Testing Strategy

Patterns and anti-patterns are `.claude/rules/testing.md`; browser methodology is the `browser-testing`
skill. Nothing below re-states them.

**Unit — `packages/shared`**

- `TeamMemberSchema` / `TeamRosterResponseSchema` parse a full row, a minimal row, and refuse a row
  missing `ownerId` (the field D1b makes required from day one — a schema that lets it be absent is how
  it becomes optional in practice).
- `warnings` absent vs `[]`: the response schema accepts absence and the aggregation never emits `[]`.

**Unit — server**

- `aggregate-team.ts`: composition (one self row, N agents, correct `ownerId` per agent, `null` on
  system agents); per-source degradation with the mesh read throwing; the operator-name precedence
  ladder including the `'You'`-never-returned assertion.
- `local-avatar-store.ts`: path containment (an `authorId` containing `..` or `/` cannot escape
  `<dorkHome>/avatars/`), magic-byte validation, size limit, overwrite-replaces, delete-is-idempotent.
- `routes/profile.ts`: the upload/serve/delete roundtrip and every negative case in §W3 Validation.
- The `AvatarStore` substitution test that proves the seam.

**Client — jsdom** (React Testing Library, mock `Transport` via `TransportProvider`)

- `IdentityAvatar` kind derivation, override precedence, `badge={null}`, image precedence, `working` dot.
- `resolveIdentityFace` table.
- `RoomMemberRow` and `MemberList` render identical shape/badge for the same member.
- `AgentAvatar`'s narrowed props — a `@ts-expect-error` on `shape` so the guarantee is compile-checked.
- `TeamPage`: filter chips, owner filter, manager grouping (**against the two-people fixture**, §W2.6),
  search, empty state, the warnings banner.
- `ProfileDrawer` for both kinds; `ProfileTab`'s three handle refusals.
- The account menu's conditional `Sign out`.

**E2E — `apps/e2e`** (registered in `apps/e2e/manifest.json`; `tests/agents/agents-page.spec.ts` is
rewritten as `tests/team/team-page.spec.ts`)

- Desktop: the roster's identity language, the chips, the owner filter, the group toggle, the three
  views, the `/agents` → `/team` redirect, opening and reloading the profile drawer, the account menu.
- Mobile (375px): one-column cards, the full-screen drawer, the account menu inside the sidebar sheet,
  Settings › Profile in the bottom drawer.
- The media-capture surfaces (`apps/e2e/capture/surfaces-desktop.ts:48,55,379,498,713`) are repointed at
  `/team`, and the fleet shot is retaken — the identity language is a visible change to a published
  screenshot.

**Mocking.** No new fake. The server tests use the existing db/mesh test harness; the client uses
`createMockTransport`; the avatar seam is exercised with an in-memory `AvatarStore`, which exists
because the interface does, not as scaffolding for the test.

**Every test carries a purpose comment, and the ones that matter can fail.** The three that would be
worthless if they could not: the `'You'` assertion (it fails today), the `@ts-expect-error` on
`AgentAvatar` (it fails before the narrowing), and the two-people roster fixture (it fails against any
component that assumes one person).

---

## Performance Considerations

- **`GET /api/team` is two reads on one machine.** `authors` is mint-on-first-use — six rows on the
  reference machine (handles spec §4) — and `agents` is the mesh registry, ~50. Both are already read
  by other routes. The client caches it under one TanStack Query key and filters, groups and searches
  **in memory**; no filter change costs a request.
- **The identity sweep is neutral by construction.** `kind` derivation is a lookup in the same
  `cva` call that already runs; it adds no element, no effect and no measurement.
- **The `working` dot replaces two existing dots**, so it is a net removal of markup.
- **Avatars are streamed, not buffered**, and revalidate against a content-hash `ETag`, so a repeated
  roster render is a 304 per face. Bounded by the number of people on the install, which is one.
- **The profile drawer is code-split behind `DialogHost`'s existing lazy pattern**, so a route that
  never opens it never pays for it.
- **The playground is dev-only** (`main.tsx:47`, `import.meta.env.DEV`) and ships in no production bundle.

## Security Considerations

- **Uploads are the new attack surface, and they are narrow by grammar rather than by filter.** Three
  content types, validated by **magic bytes** — the header the client sends is a claim, not evidence.
  SVG is refused outright rather than served under a bespoke CSP, because the safe way to serve one
  (`files.ts:109-116`) is machinery a photo does not need.
- **Path traversal.** The filename is derived from the opaque author id and never from user input; the
  store additionally asserts the resolved path is inside `<dorkHome>/avatars/`, the same containment
  check `routes/uploads.ts:84-91` makes.
- **`nosniff` on every avatar response**, so a file that lies about its type cannot be re-interpreted by
  the browser.
- **Size is bounded before the write** by multer `limits`, not after — a 2 MB cap enforced post-write is
  a disk-fill bug.
- **`naturalKey` still never reaches the wire.** `TeamMemberSchema` carries an opaque roster id, a
  handle and a render cache. An agent's `projectPath` **is** carried on `agent.projectPath` — as it
  already is on `TopologyAgent` and rendered in the fleet table today — and that is unchanged, not
  widened, by this spec.
- **`person.email` is returned only on the viewer's own row**, enforced in the aggregation and pinned by
  a test, so the shape is right before there is a second person.
- **The handle write path is not duplicated.** Settings › Profile calls the handles spec's own route; no
  new handle-writing surface exists, which keeps that spec's S6 invariant ("no automated path can change
  a handle") true.
- **Nothing here becomes an authorization.** `ownerId` is attribution rendered on a card. Ownership,
  membership and `isOwner` (`author-registry.ts:590`) keep reading the ids they read today.
- **The roster is read-only.** `GET /api/team` mints nothing and writes nothing, so it cannot create an
  identity by being called.

## Documentation

- **`docs/`** — the agents/fleet concept page becomes the **Team** page: what the roster shows, what the
  shapes mean (square is an agent, circle is a person), what "by @someone" means, and where your own
  profile and photo live. Written to the `writing-for-humans` bar. Every `/agents` link in `docs/` is
  repointed; `docs/changelog-archive.mdx` is **not** rewritten — it is a historical record.
- **`contributing/design-system.md`** — a short "Identity" section: the kind → shape/variant/badge table
  (W1.1) as the one place the convention is written down, pointing at `identity-avatar.tsx` as the
  implementation.
- **`.claude/skills/maintaining-dev-playground/SKILL.md`** — the `category` claim corrected (§W4.4), and
  the registration checklist gains the seventh touch point (§W4.1).
- **In-code** — the TSDoc quoted in §W1.1, §W1.4, §W1.6 and §W3.5 is the design record for each seam.
- **Changelog** — one fragment per workstream in `changelog/unreleased/`, at implementation time.
- **API** — `/api/team` and `/api/profile/avatar` get `registry.registerPath` entries, so they appear at
  `/api/docs` like everything else.

## Implementation Phases

**Phase 1 — W1, the identity language.** `kind` on `IdentityAvatar`, `working` slot, `AgentAvatar`
narrowed, the 23-row sweep, `resolveIdentityFace`, the three dedupes, the `SessionOriginMark` rename.
Ships alone and is worth shipping alone: seventeen surfaces start telling agents and people apart, with
no server change and no new route. **Depends on nothing.**

**Phase 2 — W2, the Team page.** `team-schemas.ts`, `services/identity/aggregate-team.ts`,
`GET /api/team`, `entities/team/`, `widgets/team/`, the route swap and the alias, the nav change,
`AgentsPage` deleted. **Depends on Phase 1** (the cards are the convention's showcase) and on **W0 /
DOR-676** for real handles; degrades to display names without it.

**Phase 3 — W3, profile and account.** `ResponsiveSheet`, the profile drawer + deep link, the account
menu, Settings › Profile, `imageUrl` across the 14 touch points, the avatar store and its two routes,
the hover card's `onViewProfile`. **Depends on Phase 2** for the roster payload the drawer renders, and
on **W0 / DOR-676** for the handle field it edits.

**Phase 4 — W4, the playground Identity page.** Registration, cross-listing, the new coverage, the mock
unification, the two documentation corrections. **Depends on Phases 1–3** for the components it shows —
it is the last phase on purpose, because a playground page that showcases half a convention is a page
that has to be rebuilt.

## Open Questions

All questions raised in ideation and the three audits are resolved. Kept with their original framing as
an audit trail.

- ~~**Roster name and route?** (RESOLVED)~~ — **Team at `/team`** (D1). Dorian's pick over the
  research-recommended "People", for control-panel voice. Accepted trade: a future agent sub-grouping
  must use another word.
- ~~**Is owner attribution a chip or a view axis?** (RESOLVED)~~ — **A view axis** (D1b), which is why
  `ownerId` is required on the payload from the first commit rather than added when grouping ships.
- ~~**Where does `ownerId` live — `AgentManifest`, `TopologyAgent`, or the payload?** (RESOLVED)~~ —
  **The payload, derived at read time.** The manifest is on-disk truth rebuilt from disk every five
  minutes (ADR-0043), so a field written there is silently rebuilt and also travels into other people's
  checkouts. `TopologyAgentSchema:443-451` is the precedent for read-time enrichment, and
  `TeamMemberSchema` follows it. See §W1.6.
- ~~**`kind: 'person'` or `kind: 'human'`?** (RESOLVED)~~ — **`'human'`**, reusing `AuthorKindSchema`
  (`room-schemas.ts:42`). A second spelling would mean a translation at every call site that exists only
  to be forgotten. The brief proposed `'person'`; the repo's own vocabulary wins. See §W1.1.
- ~~**Fold `AgentAvatar` away entirely?** (RESOLVED)~~ — **No: narrow it, and fold down only the
  presentational half.** The health ring is mesh vocabulary `shared/` must not learn; deleting the
  wrapper would hand-roll a ring twelve times. Narrowing its props removes the escape hatch, which is
  what the fold was for. See §W1.2.
- ~~**Does the operator's stored display name change from `'You'`?** (RESOLVED)~~ — **No.** The two
  contexts diverge: a room renders `'You'` from the operator's own seat; the roster resolves the real
  name through an explicit precedence and never reads the constant. `bindOwner` is untouched. This
  answers the user-model audit's open question (e)1. See §W2.2.
- ~~**Is there a right-drawer/full-screen primitive to reuse?** (RESOLVED)~~ — **No, and one is added.**
  Every `Responsive*` in `shared/ui` pairs a desktop overlay with a **bottom** drawer; the right-side
  behaviour is hand-rolled twice already (`RightPanelContainer.tsx:199-216`, `sidebar.tsx:179-201`).
  `ResponsiveSheet` is the third-use extraction. See §W3.2.
- ~~**Local upload, Gravatar, or the cloud account?** (RESOLVED)~~ — **Local upload only** (D5), behind
  an `AvatarStore` interface so a server or cloud backend is an implementation rather than a rewrite.
  No Gravatar, no network fetch. This answers the user-model audit's open question (e)2. See §W3.5.
- ~~**Which of the two Better Auth accounts is "the" identity?** (RESOLVED)~~ — **The local one.** The
  cloud link stays a separate, optional tab and is not reconciled here. Answers (e)3. See §W3.6.
- ~~**Move the identity showcases or cross-list them?** (RESOLVED)~~ — **Both, split by layer.** The
  registry is title-keyed and globally unique, so cross-listing cannot mean two entries; it means
  rendering the same showcase on a second page with a composed `PageConfig.sections`. `shared/ui`
  primitives keep their `components` anchors; entity-layer sections move. See §W4.2.
- ~~**Does touch long-press on the hover card land here?** (RESOLVED)~~ — **No; it stays with DOR-950.**
  The card's own TSDoc scoped it out with a real argument (its own gesture, its own dismiss, its own
  conflict with scroll), and this program gives touch a better answer than a long-press card: a tap
  opens the profile drawer, which is the full version of what the card summarises. DOR-950 re-evaluates
  after the drawer ships. See §Relationship to Existing Tracker Items.

## Related ADRs

**Seeded by this spec** (`status: draft`, `extractedFrom: identity-consistency`):

| id              | Title                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `260806-222535` | The Team roster is a read-surface aggregation over existing identity stores          |
| `260806-222545` | Identity kind drives shape, fill and badge in `IdentityAvatar`                       |
| `260806-222546` | `imageUrl` is the fourth render-cache field, stored locally behind a sync-ready seam |
| `260806-222547` | A profile is a drawer to view and a settings tab to edit                             |

**Constraining this work:**

- **ADR-0043** — the file is the canonical source of truth for the mesh registry. Why `ownerId` is not a
  manifest field (§W1.6).
- **ADR-0310** — session listing aggregates across runtimes and degrades per runtime. The response shape
  `GET /api/team` copies (§W2.2).
- **ADR-0320** — the local account is optional and off by default. Why `Sign out` is conditional (§W3.1).
- **ADR-0311** — Better Auth is the local account layer. Where `user.image` lives (§W3.5).
- **`260726-170126`** — author identity is keyed on the agent's directory; `naturalKey` never reaches the
  wire (§Security).
- **`260726-170125`** — a room is a membership-scoped durable stream. Why `'You'` stays room-scoped
  (§W2.2).
- **`260727-181825`** — user-safe defaults. `imageUrl` is optional and absence renders the emoji, never a
  broken image.
- **ADR-0254** — Agent Hub as the sole surface listing every agent: the nearest precedent for what
  `/team` extends.

## References

- **Specs:** `specs/handles/02-specification.md` (W0; Phase 3's human surface partly absorbed here) ·
  `specs/community-adapter/02-specification.md` (`CommunityMemberSchema`, `ownerMemberId`) ·
  `specs/invites/02-specification.md` (`user:<id>` natural keys, `viewerAuthorId`) ·
  `specs/community-server/01-ideation.md` (still ideation; gates real remote members) ·
  `specs/room-participation/02-specification.md`
- **Research:** `research/20260806_identity-component-audit.md` ·
  `research/20260806_dev-playground-structure-audit.md` ·
  `research/20260806_user-model-and-community-plans-audit.md` ·
  `research/20260724_multi-user-communities.md` (A4, opaque stable ids) ·
  `research/20260727_agent-identity-in-communities.md` (owner-vouched admission) ·
  `research/20260728_handle-systems-prior-art.md` ·
  `research/20260322_agents_page_fleet_management_ux_deep_dive.md`
- **Design:** `plans/composer-identity-components/design-handoff.md` ·
  `.dork/visual-companion/38863-1786052797/` (`directory-and-profile.html`, `team-and-profile-v2.html`)
- **Rules:** `.claude/rules/fsd-layers.md` · `.claude/rules/components.md` · `.claude/rules/testing.md` ·
  `.claude/rules/dork-home.md` · `.claude/rules/server-structure.md` · `.claude/rules/api.md`
- **Tracker:** DOR-676 (prerequisite) · DOR-677 (absorbed in part) · DOR-949 (related) · DOR-950
  (absorbed in part) · DOR-951 (the shipped identity programme this extends) · DOR-605 (account
  lifecycle, later)

---

## Relationship to Existing Tracker Items

| Item                | Relationship                                              | Precisely what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-675**         | Done                                                      | Phase 1 of the handles spec; the blocker for DOR-676.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **DOR-676**         | **Prerequisite, pulled into this program (D3)**           | `authors.handle`, the grammar module, derivation, the tombstones, `PATCH …/handle`, the human's handle capture. Specified in `specs/handles/`; **this spec re-specifies none of it** and consumes three things (§W0).                                                                                                                                                                                                                                                                                                                                                            |
| **DOR-677**         | **Absorbed in part; the ticket is re-scoped, not closed** | Handles spec Phase 3 lists five things. **Absorbed here:** handle _editing_ in settings (→ §W3.3), avatar upload against `user.image` (→ §W3.5, generalized to `imageUrl` across the render cache), the hover card's live wiring (→ §W3.2, `onViewProfile`), and the profile drawer (→ §W3.2, generalized to any kind rather than an author-only card). **Stays on DOR-677:** the room mention _chip_ rendered from `mentionSpans` — it is room-message rendering, it depends on the write-time spans DOR-676 emits, and it has nothing to do with the roster.                   |
| **DOR-949**         | Related, separate                                         | Seeding agent colours and icons (~16% have an icon, ~5% a colour). This program makes a colourless agent look _correct_ (letter fallback, filled disc, `readableForeground`); it does not seed anything. The two land well together and neither blocks the other.                                                                                                                                                                                                                                                                                                                |
| **DOR-950**         | **Split, not absorbed**                                   | **Delivered as DOR-957:** click-to-profile on pills and avatars (→ §W3.2 — the drawer is the destination it was waiting for). **Not taken: the square-at-`xs`/`sm` showcase is in progress as DOR-955 in another session**, so §W4.3's `Identity Sizes` row is external to this program and W4 must not build a second one. **Stays on DOR-950:** touch long-press on the hover card, deliberately (§Open Questions) — a tap now opens the drawer, which is a better answer than a long-press card, so 950 re-evaluates whether the gesture is still wanted after Phase 3 ships. |
| **DOR-955**         | External, in progress elsewhere                           | The square-at-`xs`/`sm` identity showcase. W4 composes it into `/dev/identity` if it has landed and leaves the slot out if it has not; it never rebuilds it.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **DOR-957**         | **Delivered by this program**                             | Click-to-profile on pills and avatars, delivered by §W3.2's drawer plus the `onViewProfile` wiring across the hover card, the Team cards, the sidebar agent list and the chat status-line chip.                                                                                                                                                                                                                                                                                                                                                                                  |
| **DOR-962**         | **Absorbed**                                              | "One agent, one face" — absorbed by §W1.4's `resolveIdentityFace`, which is the single implementation `RoomMemberRow` and `MemberList` both render through.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **DOR-954**         | Complementary, no dependency                              | Hover-card agent chips. §W3.2's drawer reuses that chip plumbing when it is present and ships its own when it is not; neither blocks the other.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **DOR-951**         | The programme this extends                                | DOR-900/903/904/905 built the presentational identity slice. This is the wiring-and-generalizing follow-up the handoff doc named, not a fork.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **DOR-605**         | Later, not blocked                                        | Multi-user account lifecycle. §W3.6 states the one thing this program owes it: do not conflict.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **DOR-946/947/948** | Out of scope                                              | Composer unification — a separate programme (§Non-Goals).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
