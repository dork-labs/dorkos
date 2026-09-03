# UI/UX Audit — Browser Auditor: UI States

**Lens:** #9 (UI states — hover, active, focus-visible, disabled, loading, empty, error, skeleton)
**Method:** Live browser against `http://localhost:6241` (real operator data) at 1440×900, using Playwright MCP. Verified computed CSS (`getComputedStyle`) and real keyboard `Tab`/`Shift+Tab` focus traversal in addition to visual screenshots, then traced every finding back to its source file. This pass independently re-drove the same five pages in a second session and re-verified Findings #1-3 live (computed `border-style`, `outline`, and `className` reads against fresh DOM, plus pixel-diff crops for the hover-contrast sub-finding below) before merging its own evidence in; Finding #4 and the loading-state coverage gap were taken as reported.

---

## Findings

### 1. Pulse/Activity table rows look and feel clickable even when they have no action (P2, effort S)

**Files:**

- `apps/client/src/layers/features/activity-feed-page/ui/ActivityRow.tsx:76-88`
- Consumed by `apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx:56-58` (Home's Pulse panel) and the full `/activity` feed — same component, so the defect is not page-local.

**Evidence:** On Home (`/`), the Pulse panel's Activity table has three rows: "DorkBot ran React to a message," "DorkOS started," and "Claude Code adapter connected." Only the third has an `item.linkPath` and shows an "Open →" button. But every `<TableRow>` in `ActivityRow.tsx` unconditionally gets `tabIndex={0}` (line 79) and the base `TableRow` primitive's `hover:bg-muted/50` styling — regardless of whether `item.linkPath` exists. Confirmed live: hovering the first two rows highlights them exactly like the third, keyboard `Tab` stops on them, and their `onKeyDown` handler at line 80-84 only fires `navigate()` when `item.linkPath` is truthy — pressing Enter on rows 1-2 does nothing. Cursor stays `auto` (not `pointer`) throughout, so the row invites a click that goes nowhere.

**Why it falls short:** A hover highlight and a keyboard tab-stop are both promises of interactivity. Two-thirds of this table breaks that promise silently — a real defect distinct from a merely-decorative row, and it recurs everywhere `ActivityRow` is used (Home Pulse panel, `/activity`, `/connections` Pulse panel — all seen live with the same three rows).

**Recommendation:** Gate the row's `tabIndex`, hover styling, and keydown handler on `item.linkPath` being present — a non-actionable row should render as plain text, not as a focusable, hover-highlighted control. One conditional in `ActivityRow.tsx` fixes every surface that renders it.

**Compounding sub-finding, same component:** even on the one row that IS actionable ("Claude Code adapter connected," which has `item.linkPath`), the promised hover feedback is nearly invisible in the dark theme. `TableRow` (`apps/client/src/layers/shared/ui/table.tsx:44-55`) applies `hover:bg-muted/50` with no override, and `ActivityRow.tsx` doesn't touch it. Measured live via `getComputedStyle`: the app's `--muted` token resolves to `0 0% 9%` (HSL lightness), the Pulse panel's ambient background is `rgb(10, 10, 10)` (~4% lightness), so `bg-muted/50` blends to roughly 6.5% lightness against a 4% backdrop — a ~2.5-point delta, confirmed by pixel-diffing before/after-hover crops of the row (visually identical). Compare the sidebar, which solves the identical problem with `bg-sidebar-accent/70` — `--sidebar-accent` is `0 0% 16%`, giving a ~12% blended result against the same ~4% backdrop, a highlight that's actually visible (confirmed live: sidebar channel/agent rows show an obvious highlight on hover). The marketplace's category-filter sidebar rows use the same higher-contrast `hover:bg-sidebar-accent/50` and are equally visible. `--muted` is the wrong token for a hover cue in this theme; `TableRow`'s hover treatment should match the sidebar's, or the design system needs a token dedicated to "visible hover state on a dark surface" that isn't `--muted`.

---

### 2. Several hand-rolled interactive controls have no `focus-visible` styling — they fall back to the raw browser outline (P2, effort S, one fix per file)

**Files (all verified live via real keyboard `Tab`, not just static CSS reading):**

- `apps/client/src/layers/features/right-panel/ui/RightPanelHeader.tsx:260-277` — the right-panel tab strip (`Pulse` / `Room` on Home; `Pulse` / `Profile` / `Session` / `Files` / `Canvas` / `Terminal` on `/session`)
- `apps/client/src/layers/features/status/ui/RuntimeItem.tsx:180`
- `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx:225`
- `apps/client/src/layers/features/status/ui/PlanModeItem.tsx:42`
- `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx:162`
- `apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:60-73`

**Evidence:** Keyboard-focusing the `/session` right-panel "Files" tab and reading `getComputedStyle` on `document.activeElement` returns `outline: auto 1px rgb(0, 95, 204)` — Chromium's native blue focus ring, not this app's `focus-visible:ring-ring/50 ring-[3px]` pattern used everywhere else (confirmed on the adjacent "Close panel" icon button, which does show the custom ring correctly). Reading `RightPanelHeader.tsx:268-273`, the tab's `className` cn() call has zero `focus-visible:` classes. The four `status/ui/*` files each independently hand-roll the identical string `'hover:text-foreground inline-flex min-w-0 ... transition-colors duration-150'` (grepped verbatim across all four) with no focus-visible treatment either — these are the runtime/model/plan-mode pills in the session composer's status line. `TaskTemplateCard.tsx:66-68` (the "activity-summary" / "code-review-digest" template buttons on the `/tasks` empty state) has the same gap: `hover:bg-accent/50` with no `focus-visible:` class anywhere in the `cn()` call.

By contrast, the shared `TabsTrigger` primitive at `apps/client/src/layers/shared/ui/tabs.tsx:26-42` already does this correctly (`focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none`) — confirmed live on the Marketplace "Browse"/"Installed" toggle, which uses that primitive and shows the correct ring. `RightPanelHeader.tsx` re-implements a tab strip from a bare `<button role="tab">` instead of reusing it.

**Why it falls short:** Keyboard users lose the app's focus language on exactly the surfaces (session mode pills, right-panel tabs, template pickers) that gate real actions — switching runtime, opening the Canvas tab, or picking a schedule template. It's also a design-token break: a jarring native blue ring inside an otherwise all-neutral/orange-ring dark UI.

**Recommendation:** For the right-panel tab strip, adopt the shared `Tabs`/`TabsTrigger` primitive (it already solves this) rather than the hand-rolled `<button role="tab">`. For the four `status/ui/*` files, extract their duplicated class string into one shared constant/component and add `focus-visible:ring-ring/50 focus-visible:ring-[3px]` (or the `focus-ring` utility from `index.css`) once. For `TaskTemplateCard.tsx`, add the same focus-visible classes to its `cn()` call.

---

### 3. Dashed border is used for two contradictory meanings on the same page (P2, effort S)

**Files:**

- `apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx:104-114`
- `apps/client/src/layers/features/connections/ui/AccountsFirstRun.tsx:57`

**Evidence:** On `/connections`, the "Accounts" section's Gmail/GitHub/Linear/Notion/Slack/Google Calendar preview cards use `border border-dashed` (`AccountsFirstRun.tsx:57`) to signal "not yet connectable — no Composio key configured." The Marketplace `/marketplace?view=installed` empty state uses the same dashed-border convention for its "No packages installed" placeholder. But the **live, enabled, actively-serving** Claude Code adapter card in the "Live now" section directly above also renders with `border-dashed` — confirmed via `AdapterCard.tsx:112-113` (`isBuiltinClaude && 'border-dashed'`, no comment explaining why) and visually in the screenshot below: a green "active" dot, a toggled-on switch, "Serving 1 agent," all inside a dashed box that on every other card on this exact page means "not available."

Screenshot: `audit-shots/connections-dashed-border-live-adapter.png`

**Why it falls short:** Dashed border is doing two jobs that mean opposite things ("this doesn't exist yet" vs. "this is live and working") on the same screen, which undermines the one piece of chrome a user would scan to tell active from inactive.

**Recommendation:** Drop the special-cased dashed border for the built-in Claude Code adapter; it already carries an "internal" badge to distinguish it from user-added connections. If a visual distinction is still wanted, use something that doesn't collide with the empty/unavailable convention (e.g., a muted label, not a border style).

---

### 4. The composer's ring never changes between idle and focused (P3, effort S)

**File:** message composer container, rendered on Home (`/`), `/session`; class chain confirmed via `getComputedStyle`.

**Evidence:** The composer's outer container always renders `border-ring ring-ring/75 ring-[1px]` (unconditional, not `focus-within:`-gated) — computed box-shadow resolves to `oklab(0.70 0.11 0.13 / 0.75)`, i.e., the app's `--ring` token (`hsl(24 88% 55%)`, an orange). This is the same token the rest of the app correctly reserves for `focus-visible`. Because the composer wears it permanently, a keyboard user tabbing into vs. away from the composer sees no additional visual change — it looks "focused" whether or not it is. Separately, the composer auto-focuses on every fresh page load (confirmed via `document.activeElement` immediately after navigation, before any `Tab` press), which is a defensible chat-app convention (Slack/Discord do the same) but is worth a note since it means a screen-reader/keyboard user's very first stop on the page is the message box, not the top nav.

**Recommendation:** Reserve the orange ring for the composer's actual `:focus-within` state, with a quieter idle border, so focus is legible there like everywhere else. Low priority — the current look is intentional-looking, not broken.

---

## What was checked and confirmed _fine_ (no finding)

To keep the "systemic" framing of Finding #2 honest, these were spot-checked and found consistent/correct, so they are not blanket problems:

- Sidebar channel row (`#team`) and agent row (`DorkBot`) hover — both get a background highlight + reveal a kebab menu on hover, consistently. (`audit-shots/home-sidebar-team-hover.png`, `audit-shots/home-sidebar-dorkbot-hover.png`)
- Bottom icon-only nav (Home/Team/Marketplace/Connections) — real `hover:bg-sidebar/50` + `hover:text-sidebar-foreground`, active route gets a persistent `bg-sidebar/70`, tooltips appear on hover. (`audit-shots/home-bottomnav-home-hover-tooltip.png`)
- Message row hover (`hover:bg-muted` + `focus-visible:ring-2`) on the `#team` feed — correct and consistent across all message authors.
- Top nav underline tabs (Home/Activity/Schedules/Workspaces) — proper `focus-visible:ring-ring` inset ring.
- Sidebar header controls ("Your team" menu, "Jump to anything…" search pill) — both have `hover:bg-sidebar-accent/70` and `focus-visible:ring-sidebar-ring`.
- Marketplace package cards — the `card-interactive` class (`hover:shadow-md`, `focus-visible:ring-2`) is applied identically to Featured-section cards and All-Packages-grid cards for the same package (Code Reviewer), confirmed via matching `className` strings on both DOM instances.
- Marketplace category/type sidebar filters — `hover:bg-sidebar-accent/50` + `focus-ring` present.
- `/connections` "Composio & Nango" disclosure trigger and adapter cards (`hover:shadow-elevated`) — correct hover feedback.
- `/connections` Gmail/GitHub/etc. "not yet connectable" preview cards — deliberately inert (no hover, no cursor-pointer, `cursor: auto`), which is the _correct_ treatment for an unavailable card, in contrast to Finding #1's Activity rows.
- Sidebar row/section hover-revealed chrome (`+`, "⋮" kebabs on Channels/Agents/section headers) initially looked like a keyboard-accessibility hole — every one of them carries `tabIndex="-1"` (confirmed via direct DOM query: only 5 real `tabIndex=0` stops exist in the entire sidebar `<nav>`), and `Tab`/`Shift+Tab` alone skips every kebab and "New channel"/"New agent" button. But this is a deliberate roving-tabindex composite (`shared/ui/sidebar-menu-node.tsx:770-777`, comment: "roving-focus hook stamps this `-1` and hands it the keyboard via ArrowRight from the row... a 60-agent Library would be 121 Tab presses rather than one"). Verified live: focusing the `#team` row and pressing `ArrowUp` moves focus straight to "New channel"; the mechanism works exactly as documented. Not a finding — flagged here only so a future auditor doesn't re-derive and misreport it as broken.

## Empty / error states observed (not created or deleted — all pre-existing)

- **`/session` (new session, no messages):** "Start a conversation — Type a message below to begin." Clean, minimal. (`audit-shots/session-empty-state.png`)
- **`/session` right panel, Profile tab, agent-less path:** "Agent not found — /Users/.../apps — The agent at this path could not be loaded." Icon + headline + path + one-line detail — a good example of the charter's no-wall-of-text rule done right. (`audit-shots/session-agent-not-found-error-state.png`)
- **`/tasks` (no schedules):** "No schedules yet. Put a skill on a timer and it runs without you." plus four suggested-template cards and a "New custom schedule" link — a strong empty state (this is also where Finding #2's `TaskTemplateCard` focus-ring gap lives). (`audit-shots/tasks-schedules-empty-state.png`)
- **`/marketplace?view=installed` (nothing installed):** "No packages installed — Browse the marketplace to discover and install your first package," dashed-border container, box icon. Consistent with the Connections preview-card dashed convention — which is exactly what makes Finding #3's misuse on the live adapter card stand out. (`audit-shots/marketplace-installed-empty-state.png`)
- **Home Pulse panel, "Needs attention":** "All quiet — nothing needs you." Seen on every page with a Pulse panel (Home, Connections, session did not show Pulse by default). Consistent phrasing across surfaces.

## Loading states

Attempted on every page via hard navigation + immediate screenshot (`/`, `/session`, `/connections`, `/marketplace`, `/tasks`). The local dev server responded fast enough on every attempt that no skeleton/spinner frame was ever caught mid-flight — real content was already painted by the first screenshot. One reload transiently hit a `data-testid="server-unreachable"` full-page state (SSE reconnect edge case, not a designed "loading" state) which is out of scope here since it wasn't a deliberate skeleton. **Coverage gap:** loading/skeleton states could not be verified on this machine at this network speed; a CPU/network-throttled pass (e.g., via CDP) would be needed to actually observe them.

**Related instability, not scored as a finding:** navigating `/session` with a session id that has no persisted messages yet (e.g. right after switching to an agent with no prior conversation, or a stale/direct-linked session id) produces a repeating `[dorkos:query-error] Session not found` / 404 loop in the console (`breadcrumbs.ts:34`) and the right panel visibly flickered open/closed across several interactions in this pass. Plausibly a React Query retry-on-error loop against a client-optimistic session id that doesn't exist server-side until the first message is sent, rather than a UI-states defect per se — noted for whichever lens/auditor covers query/session lifecycle, since it manifests as an unstable panel that a UI-states pass would otherwise misattribute to a hover/focus bug.

---

## Coverage

**Viewport:** 1440×900 throughout (per assignment — a separate responsiveness lens covers other breakpoints).

**Pages visited:** `/` (Home, #team room), `/session` (new session + an existing session), `/connections`, `/marketplace` (Browse tab), `/marketplace?view=installed` (Installed tab), `/tasks`.

**Checked on each:**

- Hover feedback: sidebar rows (channels, agents), bottom icon nav, top underline nav, message rows + message-action toolbar reveal, Pulse/Activity table rows, connection/adapter cards, marketplace package cards (Featured + All Packages), marketplace filter sidebar, disclosure triggers.
- Keyboard focus-visible: real `Tab`/`Shift+Tab` traversal (not just static class reading) on Home's initial focus target, the right-panel tab strip, session status-line pills, top nav links, Marketplace Browse/Installed toggle.
- Empty/error states: `/session` new-session and agent-not-found, `/tasks` no-schedules, `/marketplace` no-packages-installed, Pulse "all quiet."
- Loading states: attempted via hard reload on all five pages; none observed (see above).
- Sibling comparisons: channel row vs. agent row hover; Featured vs. All-Packages card hover; Activity rows with vs. without a link; dashed-border usage across three different surfaces; four independently-implemented status-line pill buttons.

**Explicitly not covered (left to other lenses/auditors):**

- `/activity` and `/workspaces` pages were not opened directly in this pass (their Pulse-panel Activity rows were exercised indirectly via Home/Connections, which render the identical `ActivityRow` component — see Finding #1).
- Team/topology views, feedback-requests, command palette, settings pages — outside this lens's assigned page list.
- Any state requiring data mutation (sending a message, installing a package, connecting an account, deleting anything) — explicitly out of bounds per the safety rules.
- Disabled-state styling was only spot-checked (`Save key` buttons on `/connections`); not systematically swept.
- Skeleton/loading UI — see "Loading states" above; needs a throttled-network pass this audit couldn't perform.
- Mobile/touch hover-equivalents — belongs to the responsiveness lens.

**Screenshots saved to** `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad/audit-shots/`:
`connections-dashed-border-live-adapter.png`, `connections-overview.png`, `home-bottomnav-home-hover-tooltip.png`, `home-sidebar-team-hover.png`, `home-sidebar-dorkbot-hover.png`, `home-tab-focus-composer.png`, `marketplace-browse.png`, `marketplace-installed-empty-state.png`, `session-empty-state.png`, `session-agent-not-found-error-state.png`, `tasks-schedules-empty-state.png`.

Added by this verification pass: `pulse-activity-row-hover-imperceptible.png` / `pulse-activity-row-no-hover-baseline.png` (Finding #1 hover-contrast before/after, same pixels), `sidebar-channel-row-hover-visible.png` and `marketplace-filter-row-hover-visible.png` (the `--sidebar-accent` contrast comparison), `home-focus-ring-new-button.png` and `tasks-schedule-card-focus-ring.png` (working focus rings for contrast against Finding #2), `home-message-toolbar-reveal.png` (message-action toolbar hover reveal), `connections-accounts-empty-state.png`, `marketplace-installed-empty-state.png`, `session-new-conversation-empty-state.png`, `tasks-no-schedules-empty-state.png` (re-captures of the same empty states from a fresh session).
