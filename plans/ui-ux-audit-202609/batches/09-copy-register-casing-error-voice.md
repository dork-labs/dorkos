[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 9 — Copy: register, casing and the error voice

**Priority P2 · 9 findings · 4S · 5M**
**Scope:** how the app sounds. The reference register already exists in the codebase — `features/notifications/**` and `settings/ui/tabs/NotificationsTab.tsx` are the best copy in the app; these findings point everything else at it.

### 9.1 — Settings speaks in two registers, and the older one is a man page

**P2 · M · lens 7**
`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:59-68,110-117,132-134,152-154,177-197,247`, `ToolsTab.tsx:153-154`, `tabs/AppearanceTab.tsx:48,61,79`, `external-mcp/RateLimitSection.tsx:24-25`, `tools/SchedulerSettings.tsx:26,40`, `PrivacyTab.tsx:63`; contrast `tabs/NotificationsTab.tsx:44-84`

**Evidence.** One dialog, two voices. Notifications is exemplary — `label="Knock when an agent needs you"`, `description="A soft double-knock the moment something stops and waits for your answer."` — benefit first, one idea per sentence, no jargon. Three tabs away:

| Current                                                                             | Problem                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `"Poll for updates to sessions running outside DorkOS (e.g. the Claude Code CLI)…"` | "Poll", "e.g.", mechanism-first, 24 words           |
| `"Server log verbosity"`                                                            | two nouns, no verb, no actor                        |
| `"Size in KB before a log file is rotated"`                                         | passive, "rotated" undefined                        |
| `"Number of old log files to retain (1-30)"`                                        | passive, "retain"                                   |
| `"Restart the DorkOS server process. Active sessions will be interrupted."`         | "server process", passive second sentence           |
| `"Server info, agent identity, app controls, and preview reads"`                    | a noun list with no verb; "preview reads" is opaque |
| `"Limit external MCP requests per time window"`                                     | MCP unglossed, "time window"                        |
| `"Scheduled runs at once"` / `"Completed runs to keep"`                             | fragments                                           |
| `"Choose your preferred color scheme"`                                              | says only what the control obviously does           |
| `"Payload shown below."`                                                            | "payload", on the privacy tab of all places         |

Priya will forgive it; Ikechi cannot use it.

**Recommendation.** Rewrite to the Notifications register. Suggested: `"Watch for agents you started somewhere else"` / `"Turn this on if work you started in a terminal takes a while to show up here."`; `"How much detail DorkOS writes down"`; `"How big one log file gets before DorkOS starts a new one"`; `"How many old log files to keep"`; `"Restart DorkOS. Anything running right now stops."`; `"Let agents check the app, know who they are, and read what you're previewing."`; `"Cap how many requests other apps can send DorkOS in a minute."`; drop `"Choose your preferred color scheme"` entirely (the control shows the choices); `"You can see exactly what gets sent below."`

### 9.2 — The "Failed to…" family, and raw server errors handed to the user verbatim

**P2 · M · lens 7**
`apps/client/src/layers/shared/lib/query-client.ts:108,136`, `layers/shared/ui/app-crash-fallback.tsx:55`, plus ~25 sites including `settings/ui/RestartDialog.tsx:33`, `ResetDialog.tsx:38`, `external-mcp/ExternalMcpCard.tsx:297,309`, `extensions/ui/ExtensionsSettingsTab.tsx:47,62,70,73`, `SettingFieldRenderers.tsx:69,127,189,238`, `ask/ui/QuestionPrompt.tsx:155`, `mesh/ui/TopologyGraph.tsx:278`, `status/ui/ModelSelectionList.tsx:67`

**Evidence.** Two problems, one pattern. First, `Failed to X` is the app's default error voice: `'Failed to restart server'`, `'Failed to reset data'`, `'Failed to fork session'`, `'Failed to load topology'`, `'Failed to load models'`, and the global default `'Failed to load data'` at `query-client.ts:108`. None of them says what to do next, and "failed to" has no actor. The app already knows the better register — `"Couldn't branch off this conversation."` (`SessionSwitcher.tsx:191`), `"Couldn't send. Try the GitHub option."`, `"Couldn't save your version"`.

Second, raw errors lead. The dominant idiom is `toast.error(err instanceof Error ? err.message : 'Failed to X')`, so the _fallback_ is the only authored copy and the common path shows whatever the server or Node threw. `query-client.ts:136` makes it app-wide: ``const line = label ? `${label} — ${error.message}` : 'Action failed. Please try again.'``. `app-crash-fallback.tsx:55` renders the bare `error.message` as the only explanation on the crash screen. A user meets `ENOENT: no such file or directory, open …` with no gloss.

**Recommendation.** Three mechanical moves. (1) Rename the family: `Failed to X` → `Couldn't X`, adding a next step where one exists (`"Couldn't reach the server. Check DorkOS is still running."`). (2) Change the global defaults: `'Failed to load data'` → `"Couldn't load that. Try again."`; `'Action failed. Please try again.'` → `"That didn't work. Try again."` (3) Stop leading with `err.message` — invert the idiom so the authored sentence is the headline and the raw text is the Sonner `description`, which `SessionSwitcher.tsx:191` already does correctly. Same for the crash fallback: a plain lead sentence with `{message}` under a "Details" line.

### 9.3 — Title Case, sentence case and SHOUTED headers, all in one product

**P2 · M · lens 7**
`apps/client/src/layers/widgets/home/ui/PinnedTriageHeaderView.tsx:88,494,524,543`, `router.tsx:280,281`, `layers/features/command-palette/ui/AgentSubMenu.tsx:89,105,110`, `settings/ui/AdvancedTab.tsx:59,75,110,177,183,195`, `settings/ui/ServerTab.tsx:78,79`, `settings/ui/RemoteAccessAction.tsx:22`, `layers/shared/ui/sidebar.tsx:270,283,286`, plus ~20 more

**Evidence.** There is no house casing rule and it shows. `router.tsx:280` `title="Marketplace Sources"` sits one line above `:281` `title="Product feedback"`. `AgentSubMenu` renders `Open Here`, `New Session` and `Browse sessions…` as three consecutive items in one menu. The home surface is the worst offender because it is the first screen: `TriageGroup` headings are `"Waiting On You"`, `"Needs Attention"`, `"Recent Activity"` — Title Case with a wrongly capitalised preposition — rendered `text-xs font-medium tracking-widest uppercase`, while `design-system.md` §"Zones and Sections" says the opposite in as many words: section labels are "sentence case, 11px medium… ALL-CAPS with letterspacing reads dated at small sizes."

**Recommendation.** Adopt **sentence case everywhere except proper nouns** (product names, "Claude Code", "DorkOS", "Slack") and write it into `contributing/design-system.md` beside the section-header rule that already implies it. Then sweep: `Waiting On You` → `Waiting on you`; `Needs Attention` → `Needs attention`; `Recent Activity` → `Recent activity` (and drop the uppercase/letterspacing treatment); `Background Updates` → `Background updates`; `Danger Zone` → `Danger zone`; `Reset All Data` → `Reset all data`; `Restart Server` → `Restart DorkOS`; `Core Tools` → `Core tools`; `Working Directory`/`Data Directory` → `Working folder`/`Data folder`; `Open Here` → `Open here`; `Add Marketplace Source` → `Add a marketplace source`; `Toggle Sidebar` → `Toggle sidebar`; `Dismiss Group` → `Dismiss these`.

### 9.4 — Message-queue jargon on the dashboard a new user lands on

**P2 · M · lens 7**
`apps/client/src/layers/features/dashboard-attention/ui/DeadLetterDetailSheet.tsx:46,55-56,62,79,95`, `layers/features/relay/ui/DeadLetterSection.tsx:106,132`, `dashboard-attention/ui/FailedRunDetailSheet.tsx:67`, `OfflineAgentDetailSheet.tsx:82`

**Evidence.** The attention sheets that open from Home say, verbatim: `Dead Letters` (sheet title), `{count} undeliverable message(s)`, `First seen:` / `Last seen:`, `Sample payload` above a raw `JSON.stringify(...)` block, `Dismiss Group`, `Mark dead letters as resolved?`, and `Sample Envelope`. The description line is the raw `source` string, falling back to `'Unknown source'`. "Dead letter", "envelope", "payload" and "source" are message-broker vocabulary; nothing on the sheet glosses any of them, so a person who has never run a message queue cannot tell whether this is bad, whose fault it is, or what "dismiss" does.

**Recommendation.** Retitle in user terms: `Dead Letters` → `Messages that never arrived`; `{n} undeliverable messages` → `{n} messages couldn't be delivered`; `First seen`/`Last seen` → `First happened`/`Last happened`; `Sample payload` → `What one of them looked like` (collapsed by default); `Sample Envelope` → `What was sent`; `Dismiss Group` → `Clear these`; `Mark dead letters as resolved?` → `Clear these messages?`; `'Unknown source'` → `"We don't know where these came from"`. Add one framing sentence at the top: `"These messages were meant for an agent and never got there. Clearing them doesn't send them."` Same pass for `Failed Run` → `Run that didn't finish` and `Offline Agents` → `Agents that aren't answering`.

### 9.5 — Em dashes in ~109 user-facing strings, including the app-wide error toast

**P2 · M · lens 7**
`apps/client/src/layers/shared/lib/query-client.ts:136` (the format string every failed mutation uses), `settings/ui/ToolsTab.tsx:147`, `agent-settings/ui/ToolsTab.tsx:245,335,436`, `status/ui/AutoModeConfirmDialog.tsx:52`, `feature-promos/ui/dialogs/SchedulesDialog.tsx:33`, `shared/ui/trust-dial.tsx:108`, `settings/ui/runtimes/GlobalTrustRow.tsx:164`, `settings/ui/WelcomeBackCard.tsx:75`, `tabs/NotificationsTab.tsx:61,131`, `connections/ui/SessionConnectorsGroup.tsx:21,22`, plus ~95 more (6 spelled `&mdash;`)

**Evidence.** The writing-for-humans house rule is unambiguous: "**no em dashes.** They invite run-on sentences that smuggle in a second idea." The highest-traffic offender is structural rather than authored — `` `${label} — ${error.message}` `` means every mutation failure in the app renders one by construction. The rule's own prediction holds in practice: `ToolsTab.tsx:147` is a 44-word sentence held together by one. (Note: a raw grep for `—` across `layers/*.tsx` hits 1,235 files, but the overwhelming majority are code comments, which the rule does not bind; the ~109 figure is the copy-position subset the copy lens filtered to, and the sweep should re-derive it rather than trust the raw count.)

**Recommendation.** Fix the structural one first: `` `${label}. ${error.message}` `` — a period, so the halves read as two sentences. Then sweep the authored strings, splitting where the dash joins two ideas and using a colon or comma where it does not. Consider adding em dash as a `check-vocab-gate.ts` rule scoped to copy positions; it is the same mechanism and the only thing that will keep the sweep paid.

### 9.6 — A non-developer is handed a shell command with nowhere to type it

**P2 · S · lens 7**
`apps/client/src/layers/shared/ui/FeatureDisabledState.tsx:11-27`, `layers/widgets/tasks/ui/TasksPage.tsx:73-79`, `layers/widgets/connections/ui/MessagingRegion.tsx:57-63`

**Evidence.** The shared primitive renders `{name} is currently disabled`, a description, and a bare `InlineCode` block. Its two production users: `"Scheduled tasks run your agents on a timer. Start DorkOS with the --tasks flag to turn them on."` with `dorkos --tasks`; and `"Messaging is off, so nothing outside DorkOS can reach your agents yet. Start DorkOS with it on."` with `DORKOS_RELAY_ENABLED=true dorkos`. Nothing says _where_ to type it, and the second shows an environment-variable prefix with no explanation. Ikechi is stuck here. The primitive is also inconsistent with itself — passive voice plus the filler "currently".

**Recommendation.** Change the headline to `"{name} is off"` and add an optional `commandHint` line above the code block, defaulting to `"Quit DorkOS, then start it again in your terminal with:"`. Lead the descriptions with the benefit: `"Scheduled tasks let your agents work on a timer, even when you're not here."` / `"Turn on Messaging so people can reach your agents from Telegram, Slack and elsewhere."` Add a `CopyButton` to the code block; it already exists in `shared/ui`.

### 9.7 — The first-run error message shows the user internal config keys

**P2 · S · lens 7**
`apps/client/src/layers/features/onboarding/model/use-onboarding.ts:109`

**Evidence.** ``toast.error(`Failed to save onboarding progress (${keys})`)`` where `keys` is a join of internal onboarding state field names. This fires during the first minutes of the product, on the surface where the user has the least context and the most doubt: passive "Failed to", no actor, an unexplained parenthetical of internal identifiers, no next step.

**Recommendation.** `"DorkOS couldn't save where you got to in setup. You can keep going, and it will try again."` Keep `keys` for the console and breadcrumb trail, not the toast.

### 9.8 — The Channels empty state points at a sidebar that does not exist on phone

**P2 · S · lenses 7 + 8**
`apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:49-59`; mobile nav model at `layers/widgets/mobile-tabs/ui/MobileTabsLayout.tsx:1-43`

**Evidence.** At 390×844 the copy reads _"Channels and direct messages live in the sidebar. Open one to read it, or make a new channel…"_ There is no sidebar on screen, no hamburger, and the shadcn `Sidebar`/`SidebarTrigger` primitives have zero call sites outside their own file. The real mobile navigation is a well-built "Library" panel raised from the bottom "All" tab — `MobileTabsLayout`'s own header comment says _"Mobile is a different app, not a squeezed desktop… no hamburger, no scrim."_ The redesign is good; the empty-state copy simply never got updated, so a first-time mobile user reads instructions describing a UI element that was deliberately removed. On desktop the same copy has a second problem: it names an action ("make a new channel") without placing a control for it anywhere nearby — the only path is the small `+` in the sidebar's Channels header, off-screen from this text.

**Recommendation.** Make the copy breakpoint-aware — `"Pick a conversation from All below"` on phone, keeping the sidebar phrasing where a sidebar is visible (`useIsMobile()` is already imported throughout for exactly this). On desktop, either add a small "New channel" button to the empty state itself or reword to point at the affordance explicitly (`"Use + next to Channels to start one"`).

### 9.9 — The Team toolbar's "Group: manager" is org-chart jargon the page never uses elsewhere

**P3 · S · lens 7**
`apps/client/src/layers/features/team-roster/ui/TeamRosterToolbar.tsx:108-115`

**Evidence.** Verified in source: the grouping chip renders the literal string `Group: manager`. Nothing on `/team` explains what "manager" groups by — it clusters agents under the person who owns them — and the surrounding code consistently says **owner** (`TeamRosterGrid.tsx`'s doc comments, the `activeFilters.owner` filter one control away). A newcomer has no way to guess the meaning.

**Recommendation.** Rename the label to match the surface's own vocabulary: `Group: owner`, or `Group by owner`. The `filters.group === 'manager'` value can stay in code; only the rendered string changes. Note `layers/widgets/team/__tests__/TeamPage.test.tsx:287,311` selects the chip by this text and must move with it.
