---
status: current
type: audit
created: 2026-08-06
---

<!-- Discovery audit for specs/identity-consistency/ (subagent report, extracted verbatim).
     Topic: Dev Playground architecture, section inventory, identity coverage gaps, restructuring constraints -->

# DorkOS Dev Playground Audit — Identity Section Planning

## (a) Playground architecture + registration mechanism

**Mount point — NOT via TanStack Router / `router.tsx`.** Despite the task framing, `/dev/*` is not a route tree entry. It is mounted as a hard branch in `apps/client/src/main.tsx:47,202-208`:

```
main.tsx:47   const DevPlayground = import.meta.env.DEV ? React.lazy(() => import('./dev/DevPlayground')) : null;
main.tsx:202-208  function Root() { if (window.location.pathname.startsWith('/dev') && DevPlayground) { return <DevPlayground /> } ... }
```

It only exists in dev builds (`import.meta.env.DEV`), replaces the entire app shell, and runs its own memory-history TanStack `Router` instance just to satisfy hooks that expect router context (`dev/DevPlayground.tsx:69-76`). Its own URL sync (`/dev`, `/dev/<page>`, `#<anchor>`) is hand-rolled via `history.pushState`/`popstate` (`dev/DevPlayground.tsx:173-198`), independent of the app router.

**Registration is a 6-layer, single-source-of-truth pipeline**, all under `apps/client/src/dev/`:

1. **`dev/playground-config.ts`** — `PAGE_CONFIGS: PageConfig[]` (lines 72-264) is the actual root of truth: id, label, description, icon, `group` (sidebar bucket), `sections`, URL `path`. `PAGE_ORDER`, `PAGE_LABELS`, and the five `*_NAV` arrays (`DESIGN_SYSTEM_NAV`, `GEN_UI_NAV`, `SESSION_NAV`, `AGENTS_NAV`, `APP_SHELL_NAV`, lines 277-289) are derived by filtering on `group`.
2. **`dev/playground-registry.ts`** — defines the `Page` type union (18 literal ids, lines 2-22) and `PlaygroundSection` interface (`id`, `title`, `page`, `category`, `keywords`, lines 25-36), then re-exports and concatenates all 18 per-page section arrays into `PLAYGROUND_REGISTRY` (lines 38-104).
3. **`dev/sections/*.ts`** (18 files) — flat arrays of `PlaygroundSection` per page, hand-written, one entry per rendered `<PlaygroundSection title="...">`.
4. **`dev/showcases/*.tsx`** (~55 files) — the actual demo components, each wrapping real app components (not recreations) in `PlaygroundSection` → `ShowcaseLabel` → `ShowcaseDemo`.
5. **`dev/pages/*.tsx`** (19 files) — compose showcases via `PlaygroundPageLayout` (`dev/PlaygroundPageLayout.tsx`), which renders `children` + a `TocSidebar` built from that page's `sections` array.
6. **`dev/DevPlayground.tsx`** — `PAGE_COMPONENTS: Record<string, ...>` (lines 88-109) maps page id → page component; sidebar renders the five `*_NAV` groups (lines 253-332) as `SidebarGroup`s with hardcoded labels "Design System" / "Generative UI" / "Session" / "Agents" / "App Shell".

**Enforced invariants (`dev/__tests__/playground-registry.test.ts`):** no duplicate section ids across the whole registry; `id === slugify(title)`; every section has ≥1 keyword; `PLAYGROUND_REGISTRY` equals concatenation of the per-page arrays; and — the load-bearing one — a **source-scan drift check** (lines 133-208) that regexes every `<PlaygroundSection title="...">` literal out of `dev/showcases/*.tsx` and `dev/pages/*.tsx` and asserts it 1:1 against the registry (both directions: unregistered showcase → fail, dangling registry entry → fail). Any new Identity page/section **must** satisfy this test or CI breaks.

**Important discrepancy vs. the skill doc:** the `maintaining-dev-playground` skill claims `category` "controls search grouping in Cmd+K results." I verified this is **not currently true** — `grep -rn "\.category\b"` across `dev/*.tsx`/`dev/*.ts` returns nothing. `PlaygroundSearch.tsx` (`dev/PlaygroundSearch.tsx:18-25,63-79`) groups exclusively by `section.page` via `groupByPage`/`PAGE_ORDER`/`PAGE_LABELS`; `TocSidebar.tsx` renders `sections` in flat array order with no category subheadings. `category` is set on every entry as a matter of convention/documentation (visible as comment-grouping in section files, e.g. `rooms-sections.ts:8-11` "Sources: RoomsShowcases — ... RoomThreadShowcases — ...") but is dead metadata today. Any Identity restructuring should either wire `category` into the UI or stop treating it as a real grouping mechanism.

## (b) Section inventory

18 pages (+ Overview, which just renders `PAGE_CONFIGS` as cards, `dev/pages/OverviewPage.tsx`), 241 registered sections total, grouped into 5 sidebar groups (`dev/playground-config.ts`):

| Sidebar group | Page (`path`)               | Showcase files rendered (from page component imports)                                                                               | # sections |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Design System | tokens                      | (page renders tokens directly, no showcase files)                                                                                   | 8          |
| Design System | forms                       | Form, ComposedForm                                                                                                                  | 15         |
| Design System | **components**              | Button, Banner, Feedback, Navigation, Sidebar, Overlay, DataDisplay, Drawer, ChatPrimitives, **Identity**                           | 38         |
| Design System | tables                      | Tables (+ TablesBasicSections/TablesAdvancedSections helpers)                                                                       | 8          |
| Generative UI | gen-ui                      | GenUi                                                                                                                               | 14         |
| App Shell     | tour-spotlight              | TourSpotlight                                                                                                                       | 1          |
| Session       | chat                        | Message, Tool, Chip, Input, Status, StatusLine, TrustDial, SessionInspector, Misc                                                   | 49         |
| Session       | entry-actions               | EntryActions                                                                                                                        | 7          |
| Session       | simulator                   | (full-page app, no discrete `PlaygroundSection`s — 1 page-level search entry)                                                       | 1          |
| Agents        | **features** ("Subsystems") | PersonalityPicker, **AgentIdentity**, AgentSidebar, AgentFleet, Relay, AdapterWizard, Mesh, Tasks, PipPanel, Approvals, Connections | 33         |
| Agents        | topology                    | Topology                                                                                                                            | 6          |
| Agents        | **rooms**                   | RoomDelivery, Rooms, RoomThread                                                                                                     | 13         |
| Agents        | marketplace                 | Marketplace                                                                                                                         | 12         |
| App Shell     | command-palette             | CommandPalette                                                                                                                      | 6          |
| App Shell     | filter-bar                  | (inline in page)                                                                                                                    | 3          |
| App Shell     | onboarding                  | OnboardingFlow, RuntimeSetup                                                                                                        | 6          |
| App Shell     | error-states                | ErrorState                                                                                                                          | 4          |
| App Shell     | promos                      | Promo                                                                                                                               | 6          |
| App Shell     | settings                    | Settings, RuntimeCard                                                                                                               | 11         |

`dev/showcases/ApprovalReceiptShowcases.tsx` exists on disk but isn't imported by any page — likely rendered as a sub-component inside `ApprovalsShowcases.tsx` rather than standalone; not identity-related, flagged only as a minor playground-hygiene note.

## (c) Identity coverage — fragmented across 3 pages, 5 showcase files, no unified home

Identity is a real, named cross-cutting concept in this codebase (an active initiative — see `plans/composer-identity-components/design-handoff.md`, "Phase-1 identity surfaces"), but its playground coverage was **deliberately split by that same plan doc** (`design-handoff.md:118-120`: _"Place on the Design System → Components page and/or Agents → Subsystems (agent identity lives there)"_).

**Already covered:**

| Component                                                                                        | Layer/file                                                 | Showcase file                                     | Page (group)                   | Registry entry                                                                  |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `IdentityAvatar` — base disc primitive, shape=agent□/person○, tint/fill, badge slot              | `layers/shared/ui/identity-avatar.tsx`                     | `dev/showcases/DataDisplayShowcases.tsx:199-314`  | components (Design System)     | `components-sections.ts:248-267` (id `identityavatar`, category "Data Display") |
| `MentionPill` — resolved @mention, agent color+Bot glyph / neutral @name / unresolved plain text | `layers/shared/ui/mention-pill.tsx`                        | `dev/showcases/IdentityShowcases.tsx:50-93`       | components (Design System)     | `components-sections.ts:268-287` (id `mentionpill`)                             |
| `IdentityHoverCard` — compact hover card, name/@handle/chips/footer                              | `layers/shared/ui/identity-hover-card.tsx`                 | `dev/showcases/IdentityShowcases.tsx:95-129`      | components (Design System)     | `components-sections.ts:288-304` (id `identityhovercard`)                       |
| `AgentAvatar` — entity-layer wrapper of `IdentityAvatar` + health ring/pulse                     | `layers/entities/agent/ui/AgentAvatar.tsx`                 | `dev/showcases/AgentIdentityShowcases.tsx:24-64`  | features/"Subsystems" (Agents) | `features-sections.ts:26-33` (id `agentavatar`)                                 |
| `AgentIdentity` — composed avatar+name+detail card                                               | `layers/entities/agent/ui/AgentIdentity.tsx`               | `dev/showcases/AgentIdentityShowcases.tsx:66-150` | features/"Subsystems" (Agents) | `features-sections.ts:34-40` (id `agentidentity`)                               |
| `MessageAuthorAvatar` — feature wrapper of `IdentityAvatar` for chat message rows                | `layers/features/chat/ui/message/MessageAuthorAvatar.tsx`  | `dev/showcases/MessageShowcases.tsx:335-...`      | chat (Session)                 | `chat-sections.ts:40-59` (id `messageauthoravatar`)                             |
| `AgentIdentityChip` — composes `AgentIdentity` + context menu, agent-switcher anchor             | `layers/features/chat/ui/status/AgentIdentityChip.tsx`     | `dev/showcases/StatusLineShowcases.tsx:352-...`   | chat (Session)                 | `chat-sections.ts:567-582` (id `agentidentitychip`)                             |
| `RoomMemberRow` — roster row with avatar/name/presence/working state                             | `layers/features/room-management/ui/RoomMemberRow.tsx`     | `dev/showcases/RoomsShowcases.tsx`                | rooms (Agents)                 | `rooms-sections.ts:33-37` (id `roommemberrow`, keywords include "presence")     |
| `AgentRosterPicker`                                                                              | `layers/features/room-management/ui/AgentRosterPicker.tsx` | `dev/showcases/RoomsShowcases.tsx`                | rooms (Agents)                 | `rooms-sections.ts:86`                                                          |
| `AgentListItem` — sidebar identity lockup (avatar+name+session)                                  | `layers/features/dashboard-sidebar/ui/AgentListItem.tsx`   | `dev/showcases/AgentSidebarShowcases.tsx`         | features/"Subsystems" (Agents) | `features-sections.ts`                                                          |

Mock data for the "identity" phase-1 slice lives centrally in `dev/mock-samples.ts:785-872` (`MockIdentity` interface + `MOCK_IDENTITIES` record — 8 cast members: agent-with-working-chip, agent-no-chip, local human, bridged/external human, system voice, and 3 named edge cases: long name/handle, no-emoji light-fill, multi-codepoint ZWJ emoji). `AgentIdentityShowcases.tsx` uses its own inline `SAMPLE`/`AGENTS` consts instead (lines 7-18) — a second, un-unified identity mock source.

**Gaps — identity-adjacent components with ZERO playground coverage** (verified via `grep -rl` across `apps/client/src/dev`, no hits):

| Component                                 | Layer/file                                                | What it is                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RoomAvatar`                              | `layers/entities/room/ui/RoomAvatar.tsx`                  | Room-level identity mark: `#` glyph for channels, a person's face (or a stacked-faces cluster) for DMs — used in `RoomRow.tsx:36`. Not shown anywhere in the playground.                                                         |
| `AvatarPickerPopover`/`AvatarPickerPanel` | `layers/features/agent-hub/ui/AvatarPickerPopover.tsx`    | The emoji/color picker used when creating/editing an agent's identity (`CreateAgentDialog.tsx`). No showcase.                                                                                                                    |
| `PresetPill`                              | `layers/entities/agent/ui/PresetPill.tsx`                 | Agent personality-preset pill (name lockup adjacent, not currently in any identity showcase).                                                                                                                                    |
| `RoomPresenceLine`                        | `layers/widgets/room-view/ui/RoomPresenceLine.tsx`        | The room's live working/presence indicator line (mentioned as a "known gap now closed" in `.claude/rules/room-conduct.md`). No showcase.                                                                                         |
| `identity-origin.ts`                      | `layers/shared/ui/identity-origin.ts`                     | Shared origin-badge helper (`local` vs `{platform}`) — underlies the external/bridged-person distinguishing UI seen in `IdentityHoverCard`/`MentionPill`, but has no standalone showcase of its own (only exercised indirectly). |
| `AgentChipContextMenu`                    | `layers/features/chat/ui/status/AgentChipContextMenu.tsx` | The context menu opened from `AgentIdentityChip` — not confirmed to render its open state in the showcase (only the closed chip is shown per the section title `AgentIdentityChip`).                                             |

Net: the human-vs-agent-vs-system-vs-external distinction (colorblind-safe shape/fill/badge language) is well covered for the _message/mention_ surfaces (`IdentityAvatar`, `MentionPill`, `IdentityHoverCard`, `MessageAuthorAvatar`) and the _agent entity_ surfaces (`AgentAvatar`, `AgentIdentity`). It is **not** covered for the _room-level_ identity marks (`RoomAvatar`, `RoomPresenceLine`) or the _identity-editing_ surface (`AvatarPickerPopover`).

## (d) Restructuring constraints and recommendation

**Grouping model, precisely:** flat list of 18 pages bucketed into 5 hardcoded sidebar groups (`design-system` | `gen-ui` | `session` | `agents` | `app-shell`, `dev/playground-config.ts:46`). Within a page, sections are a flat ordered array with a `category` string that is **metadata only** (not rendered as a subheading anywhere — see the (a) discrepancy above). There is no sub-page or nested-group concept; "page" is the only real navigational/URL/search unit.

**The skill's own decision rule** (`.claude/skills/maintaining-dev-playground/SKILL.md`, "When to create a new page"): create a new page only when a feature has **5+ sections** that don't fit an existing page, or is a complex multi-component system warranting dedicated space. Identity currently totals **10 registered sections** split 3+4+3 across three showcase files (`IdentityShowcases.tsx` + `DataDisplayShowcases.tsx`'s Identity section, `AgentIdentityShowcases.tsx`, `MessageShowcases.tsx`+`StatusLineShowcases.tsx`'s Identity sections) plus the identified gaps above (~4-5 more if built out) — comfortably clears the 5+ threshold for a dedicated page once consolidated, and the skill explicitly allows a component to appear on multiple pages "if it genuinely belongs in both contexts," so a dedicated Identity page would not require _removing_ `AgentAvatar`/`AgentIdentity` from Subsystems if cross-listing is preferred — though the registry-drift test only matches on section `title`, not on `(title, page)` pairs, so watch for accidental duplicate titles if the same showcase is rendered on two pages.

**Concrete constraints to respect when restructuring:**

1. Any new page requires: `Page` union member in `playground-registry.ts:2-22`, a new `dev/sections/identity-sections.ts` exported/imported/spread in `playground-registry.ts` (both the named export block, lines 38-56, and the aliased-import/spread block, lines 59-104), a `PageConfig` entry in `playground-config.ts` (icon, `group`, `description`, `path`), a `dev/pages/IdentityPage.tsx` using `PlaygroundPageLayout`, and a `PAGE_COMPONENTS` entry + import in `DevPlayground.tsx:88-109`. Six touch points, all confirmed live code (not aspirational).
2. Every `<PlaygroundSection title="...">` rendered must have a literal string title (not computed) and a matching `dev/sections/*.ts` entry with `id === slugify(title)`, or `dev/__tests__/playground-registry.test.ts` fails the build.
3. Existing identity showcase files (`IdentityShowcases.tsx`, `AgentIdentityShowcases.tsx`, and the Identity-related sections inside `DataDisplayShowcases.tsx`, `MessageShowcases.tsx`, `StatusLineShowcases.tsx`) can be _moved_ (imported into a new `IdentityPage.tsx` instead of `ComponentsPage.tsx`/`FeaturesPage.tsx`/`ChatPage.tsx`) without touching the showcase components themselves — but doing so changes each section's `page` field in its `dev/sections/*.ts` entry, which changes its Cmd+K page-group heading and its `/dev/<page>#<anchor>` URL; anything (docs, saved links) referencing `/dev/components#identityavatar` etc. would break.
4. Mock data consolidation: `AgentIdentityShowcases.tsx` currently uses inline `SAMPLE`/`AGENTS` rather than the shared `MOCK_IDENTITIES` in `dev/mock-samples.ts:810-872` — a restructure is a natural point to unify on one mock-identity source per the skill's mock-data convention ("keep mock data alongside showcases... `dev/mock-factories.ts`/`dev/mock-samples.ts`").
5. The plan doc `plans/composer-identity-components/design-handoff.md` is the authoritative design source for the _why_ of current placement and lists a still-open "follow-up slice" (wiring these presentational components into the live feed/composer) — worth checking whether that slice has landed before deciding whether Identity restructuring happens now or waits for it.

**Recommendation:** given 10 existing sections clear the 5+ threshold, given identity spans 3 FSD layers (shared/entities/features) and currently 3 unrelated playground pages, and given there are real, unaddressed identity-adjacent gaps (`RoomAvatar`, `AvatarPickerPopover`, `RoomPresenceLine`), a dedicated **Identity page** is justified under the skill's own rule. Natural sidebar placement is the **Agents** group (sits beside `features`/"Subsystems" and `rooms`, both of which already host agent/room identity primitives) rather than Design System, since the content is domain-specific agent/human/room identity rather than generic UI primitives — though `IdentityAvatar`/`MentionPill`/`IdentityHoverCard` being FSD `shared/ui` components is an argument for keeping at least a subset under Design System → Components per the existing plan doc's placement rule. This is a real tension the restructuring should resolve explicitly (layer-purity vs. concept-cohesion) rather than split by convention as today.
