[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 12 — Settings information architecture

**Priority P2 · 6 findings · 5S · 1M**
**Scope:** one PR reshaping the Settings dialog. Thirteen tabs today; these findings take it to eleven with predictable contents. Deep links must keep working via the legacy map in `use-dialog-deep-link.ts`, which exists for exactly this kind of move.

### 12.1 — "Advanced" is a junk drawer, and three of its four sections belong on other tabs

**P2 · M · lens 11**
`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:57-217`, `SettingsDialog.tsx:112`

**Evidence.** One tab holds four unrelated sections in a flat stack: **Background Updates** (a polling switch, `:59-73`), **Message Box** (the rich-text switch, `:75-106`), **Logging** (level, max file size in KB, rotated files kept, log location, `:108-173`), and **Danger Zone** (Reset All Data, Restart Server, `:175-205`). Every row is at the same visual level; nothing is collapsed. "Advanced" is not a category, it is the absence of one — and three of the four have an obvious home. "Format text as you type" is a composer preference whose own inline comment says it is now ON by default, so it is not advanced at all. "Background refresh" is a general app preference. Logging is a property of this machine's server, which is what the Server tab is. What is left — Reset and Restart — is a real danger zone and deserves to be the tab. Meanwhile `maxLogSizeKb` and `maxLogFiles` are two numeric fields that matter to almost nobody, rendered flat _above_ the destructive actions.

**Recommendation.** Redistribute: Message Box → Preferences (beside the other chat-display rows); Background refresh → Preferences; Logging → Server, inside a `CollapsibleFieldCard` labelled "Logging" (level visible in the summary, rotation fields inside). Rename the tab **Danger zone** and let it hold only Reset and Restart, so its icon and name predict its contents.

### 12.2 — "Background refresh" is a machine-wide preference offered as a per-session control

**P2 · S · lens 11**
`apps/client/src/layers/features/status/model/status-bar-registry.ts:470-486`, `layers/features/status/ui/SessionPopover.tsx:252-260`, `layers/features/chat/ui/status/ChatStatusSection.tsx:104-105`, `settings/ui/AdvancedTab.tsx:66-71`

**Evidence.** The `polling` registry entry sits in the **`controls`** group of the Session popover and renders a `Switch`. Its value comes from `useAppStore((s) => s.enableMessagePolling)` — a global app-store field, not session state — and the identical switch also exists in Settings → Advanced. This is the defect the registry itself records having fixed for a sibling row seven lines above: _"`sound` used to live here as a switch. It is gone (DOR-1385): it read as a per-session control and was not one — it flipped a preference for every session on the machine."_ `polling` has exactly that property and was left in place. A person toggling it inside the Session panel reasonably believes they changed this session; they changed every window on the machine.

**Recommendation.** Remove the `polling` entry from the registry's `controls` group the way `sound` was removed, leaving Settings as its one home. If a shortcut from the session is still wanted, make it a link into `?settings=…` — a deep link cannot misrepresent its scope. The `controls` group then holds only `plan`, which genuinely is per-session.

### 12.3 — The first four tabs are an unnamed implicit group, and "Remote Access" is a dialog wearing a tab's clothes

**P2 · S · lens 11**
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:35-52,112,135,140`, `RemoteAccessAction.tsx:11-38`, `apps/client/src/layers/shared/ui/tabbed-dialog.tsx:126-131,191-212`

**Evidence.** Thirteen tabs. Nine carry a `group` — "Agents & sessions", "Access & privacy", "System" — and four (Profile, Appearance, Preferences, Notifications) carry none, so `tabbed-dialog.tsx:126-131` renders them as a headerless run above the first section header: the list reads as "four loose things, then three real sections". Below the last group, `sidebarExtras` renders `RemoteAccessAction` — a button styled almost exactly like a `NavigationLayoutItem` (icon + label + hover tint) that opens `TunnelDialog`, a second modal on top of the settings modal. On mobile it even renders with the drill-in `ChevronRight` every _tab_ row uses, so the disguise is strongest exactly where the recovery gesture is worst. A control that sits in a list of tabs and looks like a tab must swap the panel; that is the one promise a settings sidebar makes.

**Recommendation.** Name the first group ("You" or "Personal") so all four regions are labelled peers. Move Remote Access into **Access & privacy** as a real tab whose panel is the current `TunnelSettings` content — same subject as Security and DorkOS account, and it removes a dialog-over-dialog. `sidebarExtras` then has no production consumer and can go.

### 12.4 — "Preferences" is a leftover bucket

**P2 · S · lens 11**
`apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx:76-153`

**Evidence.** One card holding six switches — Show timestamps, Expand tool calls, Auto-hide tool calls, To-do celebrations, Feature suggestions, **Show dev tools** — then `WelcomeBackCard`, then a second card with **Replay setup**. Four of the six are chat-display settings; one is a promotion control; one turns on a developer panel; the tail is a first-run flow you can re-trigger. "Preferences" here means "settings that had nowhere else to go", the same failure as Advanced one tab down. A developer-tools toggle sitting flat between "To-do celebrations" and a re-run of onboarding is what makes Ikechi feel he is in the wrong room, and Kai has to read six unrelated labels to find the one about tool cards. The tab's own comments (`:107-117`) already record two settings being moved out for coherence, so the direction of travel is established.

**Recommendation.** Group inside the tab rather than adding tabs: one **Chat** `FieldCard` (timestamps, expand tool calls, auto-hide tool calls, celebrations, plus the Message Box row relocated from Advanced per 12.1), and one **Discovery** row (Feature suggestions beside "Replay setup" — both are about being shown things again). Move "Show dev tools" to the System group with the other developer-facing switches.

### 12.5 — Server settings mixes the one thing you came for with five diagnostics

**P3 · S · lens 11**
`apps/client/src/layers/features/settings/ui/ServerTab.tsx:41-83,141-174`

**Evidence.** Eight flat rows at the same weight: Version, an update notice, Address + MCP endpoint, Uptime, Working Directory, Data Directory, Boundary, Node.js — every one a click-to-copy row. Two of these are why anyone opens the tab (the address to paste into an MCP client, and the version); the rest are diagnostics you want once, when something is wrong. "Boundary" and "Node.js" are words Ikechi has no model for, and presenting them at the same weight as the address costs the address its prominence. The tab already has a `CopyDiagnosticsButton` sibling in `features/status` proving the "copy the whole lot" pattern exists here.

**Recommendation.** Keep Version, Address, MCP endpoint and Uptime at the top level. Put Working Directory, Data Directory, Boundary and Node.js inside a `CollapsibleFieldCard` labelled "Diagnostics", collapsed by default, with one copy-all control in its header — so the support path is one click and one paste rather than four separate copies.

### 12.6 — "Security" and "DorkOS account" are two tabs holding one question

**P3 · S · lens 11**
`apps/client/src/layers/features/settings/ui/SecurityTab.tsx:1-12`, `CloudAccountTab.tsx`, `SettingsDialog.tsx:78-98`

**Evidence.** The "Access & privacy" group holds three tabs, two of which are 12-line and 14-line wrappers: `SecurityTab` renders `SecurityPanel` (local login + API keys) and `CloudAccountTab` renders the cloud link. Both answer "who can get into this install, and as whom". Two sidebar rows, two icons and two panel headers for one panel's worth of content, in a sidebar already carrying thirteen rows. Every element justifies its existence (AGENTS.md §Quality Standard) — a tab whose whole body is one component and whose subject is the neighbouring tab's subject does not.

**Recommendation.** Merge into one **Access** tab with two `FieldCard` sections ("On this machine" — login and API keys; "DorkOS account" — the cloud link). Keep `?settings=security` and `?settings=account` working through the legacy map in `use-dialog-deep-link.ts` and let it scroll to the section.
