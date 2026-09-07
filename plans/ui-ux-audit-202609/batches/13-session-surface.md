[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 13 — The session surface: fewer things competing

**Priority P2 · 5 findings · 1S · 4M**
**Scope:** the `/session` route and the right panel. Every finding here is "an internal standard exists and has not reached a second surface" — the arbiter, the viewport cap, the disclosure primitive.

### 13.1 — The zone between the transcript and the composer has no arbiter

**P2 · M · lens 11**
`apps/client/src/layers/widgets/session/ui/ChatPanel.tsx:492-580`, `apps/client/src/layers/shared/ui/bottom-slot.tsx:1-19`, `layers/features/notifications/ui/PermissionPrimer.tsx:94-102`, `layers/shared/ui/PromptSuggestionChips.tsx`

**Evidence.** `ChatPanel` renders, in flow between `SessionTranscript` and `SessionComposer`: `TerminalReasonChip`, `Conversation.LiveLane`, `PromptSuggestionChips`, the `chat.suggestion-chips` extension slot (N contributions), `TaskListPanel`, `TurnFailedNotice`, an error block, and `PermissionPrimer` — eight independent blocks, each gating itself on its own predicate, with no shared priority and no shared budget. `PromptSuggestionChips` (`:526`) and the extension chips (`:536`) both fire on `status === 'idle'`; `TaskListPanel` (`:543`) fires on `tasks.length > 0`; `PermissionPrimer` (`:572`) fires independently. They co-occur. ADR `260819-210153` decided exactly this question for the sidebar — "four independent cards with no shared priority" — and shipped `shared/ui/bottom-slot.tsx`, whose own header says "This is the one place they arbitrate: highest priority wins, and the next card waits its turn." The primitive already takes an ordered candidate list and knows nothing about the features it renders. The chat panel is the second instance of the problem the ADR solved and did not get the fix.

**Recommendation.** Wrap the promotional and advisory blocks — `PromptSuggestionChips`, the extension chip slot, `PermissionPrimer`, and any future card — in a `BottomSlot` with an explicit priority order, so at most one speaks at a time. Leave the three that are not competing for attention outside it: `LiveLane` (a reserved line by design), `TaskListPanel` (content about the running turn, not an offer), and the error/turn-failed blocks (a failure must never be arbitrated away). Document the priority beside the candidate list the way `useAppBanners` does.

### 13.2 — The session to-do panel opens expanded and uncapped, directly above the composer

**P2 · S · lens 11**
`apps/client/src/layers/features/chat/ui/tasks/TaskListPanel.tsx:27,56,63,74`, `layers/features/chat/model/use-task-state.ts:78`, `layers/widgets/session/ui/ChatPanel.tsx:543-551`

**Evidence.** `use-task-state.ts:78` initialises `useState(false)` for `isCollapsed`, so the panel arrives **open**. `TaskListPanel.tsx:27` sets `MAX_VISIBLE = 10`, and the `<motion.ul>` at `:74` is `className="mt-1 space-y-0.5"` — no `max-h`, no internal scroll. Ten task rows plus the progress header plus the active-form line render in flow between transcript and composer, on every device. The repo has already measured this exact failure once: `PinnedTriageHeaderView.tsx:26-53` documents that at 375×812 "the room's masthead, composer and presence line already spend ~180px, so a 50svh header leaves the conversation under a third of the screen", and caps that header at `max-h-[40svh] sm:max-h-[50svh]`. The to-do list is the same shape of component in the same position with none of that protection: an agent that emits a ten-item plan pushes the conversation off the phone screen, by default rather than on request.

**Recommendation.** Two small changes. (a) Give the list the same treatment the triage header got — `max-h-[30svh] sm:max-h-[40svh]` plus `overflow-y-auto` on the `<ul>` — so a long plan scrolls inside itself instead of growing the zone. (b) Default `isCollapsed` to `true` once the turn that produced the list has ended, keeping it open only while the plan is actively changing. The progress header already carries the counts, so a collapsed panel loses no signal.

### 13.3 — The right panel carries six competing tabs on `/session`, in a panel that floors at 320px

**P2 · M · lens 11**
`apps/client/src/app/init-extensions.ts:144-300`, `layers/features/right-panel/ui/RightPanelHeader.tsx:136-300`, `layers/features/right-panel/model/use-right-panel-sizing.ts:18`

**Evidence.** `registerRightPanelTabs` registers six contributions visible on `/session`: Pulse (5), Profile (10), Session (12), Files (15), Canvas (20), Terminal (25); a seventh, Room, is visible on `/` and `/channels`. The strip renders every one as icon + label at `text-[10px]` inside a horizontally scrolling box with edge fades, and the panel's floor is `MIN_WIDTH_PX = 320`. `RightPanelHeader.tsx:136-143` states the problem in its own doc comment: _"Six tabs are wider than a 375px overlay panel, and a tab pushed past the edge with no way to reach it is a lost surface."_ A scroll-plus-fade is a mitigation, not a design: at the panel's own minimum width roughly half the tabs are off-screen, so "where is the terminal" depends on scroll position, and the mitigation itself needed a `ResizeObserver` over three boxes plus an explicit reveal (`:196-235`) to stop being wrong. Two of the six also overlap by the registry's own admission — `init-extensions.ts:234-241` says the Session tab and the status line's `⋯` popover "answer the same question at two different commitments".

**Recommendation.** Get `/session` to four or fewer. The natural merge is a single **Workspace** tab holding Files, Canvas and Terminal behind an inner segmented control: they are one concept (this session's working directory), they are gated on the same route, and Terminal already self-hides under the Obsidian transport, so the inner control is already variable-length. That leaves Pulse · Profile · Session · Workspace. If a further cut is wanted, fold the Session readout into Profile as a section rather than a peer, since the `⋯` popover already covers the two-second peek.

### 13.4 — Four different progressive-disclosure idioms, so "Advanced" looks different on every surface

**P2 · M · lens 11**
`apps/client/src/layers/shared/ui/field-card.tsx:57-91` (`CollapsibleFieldCard`), `layers/features/tasks/ui/TaskFormInner.tsx:363-369,413-418` (native `<details>` with hand-rolled summary chrome), `layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-199` (native `<details>`, a third summary style), `layers/features/settings/ui/runtimes/RuntimeCardView.tsx:379-386` and `settings/ui/tools/ToolGroupRow.tsx:82-110` (Radix `Collapsible`, two different trigger treatments), `layers/features/chat/ui/tools/ToolCallCard.tsx:113` (`CollapsibleCard`), `layers/features/agent-settings/ui/IdentityTab.tsx:363` (`CollapsibleFieldCard`)

**Evidence.** `design-system.md` §FieldCard documents `CollapsibleFieldCard` as _the_ disclosure primitive for settings groups; it has exactly three production call sites. Everywhere else disclosure is re-implemented: a native `<details>` with `ChevronRight … group-open:rotate-90` in the task form, a different native `<details>` with its own summary typography in the install preview, a bare Radix `Collapsible` with an inline text trigger in the runtime card, and another with an `asChild` row trigger in `ToolGroupRow`. Progressive disclosure only works if the affordance is learnable — someone who learns that a chevron-and-uppercase-label opens a section in the install dialog gets no help from that in the task form, the runtime card or agent settings. The _behaviour_ also differs invisibly: only `CollapsibleFieldCard` supports a `badge` summarising what is inside, so the other three disclose without saying what they are hiding, which is the half of disclosure that makes it safe.

**Recommendation.** Settle on `CollapsibleFieldCard` for every **form or settings** disclosure — including a trailing summary badge stating what is inside ("3 overrides", "7 files") — and migrate the four hand-rolled ones. Keep native `<details>` only for disclosure _inside content_ (a tool card's output, a stack trace in `route-error-fallback.tsx`), and write that rule into `contributing/design-system.md` so the next author has a rule rather than five examples. Overlaps lens 3; the finding here is about the affordance, not the code duplication.

### 13.5 — Pulse duplicates the Activity page it sits beside

**P2 · M · lens 11**
`apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx:20-62`, `PulseAttentionSection.tsx`, `PulsePanel.tsx:29-35`, `layers/widgets/activity/ActivityPage.tsx:38-64`

**Evidence.** On `/activity` with the right panel open, the main content area's "Today" table and the Pulse panel's "Activity" table show the **exact same three rows** at the same timestamps, side by side on one screen (confirmed live, screenshot `03-activity-duplicate-panel.png`). `PulseActivitySection` already reads the pathname (`useSafePathname()`, `:25`) and uses it for exactly one thing: hiding the "Open activity →" button when you are already on `/activity` (`:26`). The five teaser rows still render. A teaser exists to point at a place you are not; pointing at the page you are looking at spends a quarter of the panel to say nothing. The attention section has the same relationship to Home's pinned triage header. This is not wrong on Home, Team or Tasks, where Pulse is a global companion and the main content is something else — it is wrong on the one page whose entire purpose _is_ the activity feed.

**Recommendation.** Extend the check the code already makes: when `pathname === '/activity'`, `PulseActivitySection` returns `null`; when the route shows the team room, `PulseAttentionSection` returns `null`. If that would leave Pulse empty on those routes, that is the honest signal that the _contextual_ tab should be the default there — which is already true on Home, where the Room tab wins auto-select (`init-extensions.ts:186-196`).
