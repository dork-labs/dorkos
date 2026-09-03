# Lens 7 — Copy (ELI5)

Auditor pass over user-facing strings in `apps/client/src`, measured against
`.agents/skills/writing-for-humans/SKILL.md` (9th-grade reading level, short sentences,
active voice with a clear actor, benefit before mechanism, define-or-drop every technical
term, **no em dashes**), the `AGENTS.md` §Quality Standard honesty gate, and the settled
vocabulary ADRs.

---

## Coverage

**Read in full (every string):**

- `layers/shared/ui/` — swept all 90 files for copy-bearing strings; read in full the ones that
  actually carry prose: `app-crash-fallback.tsx`, `route-error-fallback.tsx`,
  `not-found-fallback.tsx`, `FeatureDisabledState.tsx`, `consent-ritual-copy.ts`,
  `trust-dial.tsx`, `unattended-autonomy-dialog.tsx`, `tabbed-dialog.tsx`,
  `ConnectionStatusBanner.tsx`, `banner.tsx`, `sidebar.tsx`, `password-input.tsx`,
  `responsive-dialog.tsx`, `navigation-layout.tsx`, `data-table.tsx`. The rest of `shared/ui` is
  shadcn primitives carrying no product prose beyond `aria-label`s, which I swept by grep.
- Settings: `AdvancedTab`, `ToolsTab`, `PrivacyTab`, `ServerTab`, `WelcomeBackCard`, all four
  `tabs/*`, `runtimes/**` (GlobalTrustRow, ModelRow, EffortRow, RuntimeCardView,
  ClaudeAccountsSection), `external-mcp/**`, `Tunnel*`.
- Onboarding: `WelcomeStep`, `SystemRequirementsStep`, `OnboardingPowerStep`,
  `ConversationDiscoveryBeat`, `ProfilePromptCard`, `model/use-onboarding.ts`.
- Errors: `query-client.ts` (the app-wide toast format), all 48 `Failed …` sites, all 60+
  `toast.*` call sites.
- Sampled by grep + targeted read: marketplace, connections, relay, mesh/topology, tasks,
  approvals/ask, full-power-door, notifications, inbox, activity, team-roster, chat empty
  states, command palette, dashboard-sidebar, home/triage, diff-review, agent-settings,
  agent-creation, extensions, feedback.

**Skipped / not covered:**

- `apps/client/src/dev/` (playground) — excluded from the vocab gate by design and not a user
  surface; lens 6 owns it.
- `__tests__/` fixture strings.
- Server-authored strings the client renders verbatim (`apps/server/src`) — out of the charter's
  `apps/client/src` scope, but note finding **P2-3**: the client hands several of them straight to
  the user untouched.
- Obsidian-embed-only copy was read where it overlaps (`EmbedSidebar`, `EmbedSessionList`) but not
  audited as its own surface.
- I did not read every `aria-label` in the app; a11y-only strings belong to lens 9/others.

**Checked against `decisions/` before flagging:** ADR-0224 (superseded), ADR `260726-193526`
(superseded in part), ADR `260804-021140` (**current** — the vocabulary contract several findings
below enforce), ADR-0230 (marketplace "package"/"agent" type names — deliberately not flagged),
`scripts/check-vocab-gate.ts` + `scripts/check-banned-words.sh` (so "cockpit" in code comments
and identifiers is **not** a finding; it is explicitly out of both gates' scope, and I found
zero occurrences of the banned words in any render-path string).

**Reference register.** `features/notifications/**` and `settings/ui/tabs/NotificationsTab.tsx`
are the best copy in the app and are what several recommendations below point at as the target.

---

### [P1/S] The riskiest permission setting describes itself like the safe one

**Files:** `apps/client/src/layers/shared/ui/trust-dial.tsx:100-109`, rendered at
`trust-dial.tsx:339`, `layers/shared/ui/unattended-autonomy-dialog.tsx:96`,
`layers/features/status/ui/AutonomyConfirmDialog.tsx:167`,
`layers/features/status/ui/PlanModeItem.tsx:52`

**Evidence.** The three canonical stops carry these captions, and the dial renders `current.promise`
directly under the segmented control:

- `act` (`asks: 'when-risky'`) — `"Gets on with the work and stops for the risky parts."`
- `autonomy` (`asks: 'never'`) — `"Acts without stopping for approval — still asks when it matters."`

Read cold by a newcomer, those two sentences say the same thing: _it works on its own and asks
about the risky bits_. The machine claims are opposites (`when-risky` vs `never`). The same
sentence is what `UnattendedAutonomyDialog` shows as its `AlertDialogDescription` — the consent
moment for an agent that will act unattended. And `consent-ritual-copy.ts:66` deliberately
withholds the honest line (`"This stop never pauses to ask. Whatever it decides to do, it
does."`) at exactly this stop, on the reasoning that "the title is the promise" — but the title is
only the two words "Full autonomy", and the sentence under it walks the promise back.

**Why it falls short.** AGENTS.md: "Be honest by design: no dark patterns." The one caption where
understating the risk actually costs the user something is the one that understates it, and it
does so in the consent dialog. It also violates rule 5 of writing-for-humans (a term the reader
must resolve from a second, contradictory clause) and the no-em-dash house rule in the same
string.

**Recommendation.** Replace the autonomy `promise` with a sentence that names the difference and
carries no hedge: `"Acts on its own. It will not stop to ask you, even for risky steps."` Keep
`FullPowerDoor`'s longer nuance (`FullPowerDoor.tsx:54`) where there is room for it; a 60-character
dial caption is not that place. Then reconsider whether `consentAsksNote` should still return
`null` for autonomy once the title's sentence is honest.

---

### [P1/M] Words an accepted ADR retired from user-facing copy are still on screen

**Files:**
`apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx:63,66,70`,
`layers/features/mesh/ui/AdapterNode.tsx:168,171`,
`layers/entities/binding/ui/BindingDialog.tsx:280,296`,
`layers/features/relay/ui/wizard/ConfirmStep.tsx:42`,
`layers/features/relay/ui/adapter/AdapterCardHeader.tsx:64`,
`layers/features/agent-settings/ui/ContextTab.tsx:207-208`,
`layers/features/agent-settings/ui/ToolsTab.tsx:419-420`,
`layers/features/marketplace/ui/MarketplaceSidebar.tsx:206`,
`layers/entities/runtime/config/runtime-descriptors.ts:80`

**Evidence.** ADR `260804-021140` (**accepted, current, "this is the last rename"**) states:
"From cockpit chrome we **retire** the words `integration`, `connector`, `adapter`, and `provider`
as user-facing nouns." All four are still rendered:

| Current string                                                                                                                                                         | File                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `Add Integration` (button), `Relay routes messages between your agents and external platforms.`, `Add your first integration to start sending and receiving messages.` | `RelayEmptyState.tsx:70,63,66`          |
| `Add Adapter` / `aria-label="Add adapter"`                                                                                                                             | `AdapterNode.tsx:171,168`               |
| `<Label>Adapter</Label>`, `placeholder="Select an adapter"`                                                                                                            | `BindingDialog.tsx:280,296`             |
| `Adapter ID`                                                                                                                                                           | `wizard/ConfirmStep.tsx:42`             |
| `aria-label="Adapter actions"`                                                                                                                                         | `adapter/AdapterCardHeader.tsx:64`      |
| `label="Adapter Tools"` / `"External platform subjects, adapter management, and binding routing conventions."`                                                         | `agent-settings/ContextTab.tsx:207-208` |
| `label: 'External Integrations'` / `'Manage integrations with Slack, Telegram, and other platforms'`                                                                   | `agent-settings/ToolsTab.tsx:419-420`   |
| `label="Connectors"` (marketplace facet)                                                                                                                               | `MarketplaceSidebar.tsx:206`            |
| `subtitle: 'Your own models, local or any provider'`                                                                                                                   | `runtime-descriptors.ts:80`             |

Meanwhile the _same_ feature's toasts already speak the new vocabulary —
`IntegrationsTab.tsx:124,153,166` fire `'Connection added'`, `'Connection removed'`,
`'Connection paused'`. So one screen calls the thing four names.

**Why it falls short.** "Consistent terminology (one name per concept)" is the lens's first
requirement, and here the product has a written contract it is not keeping. `check-vocab-gate.ts`
exists precisely to stop this class of rot but has only shipped Wave 1 ("connection"); its own
header names `integration, connector, adapter, provider` as the planned Wave 2, which never
landed.

**Recommendation.** Sweep the strings above to the ADR's product vocabulary — **Connections**
(umbrella), **Messaging** (the Relay region), **Accounts** (the ConnectorProvider region).
Concretely: `Add Integration` → `Add a connection`; `Relay routes messages between…` →
`Connections let people and platforms reach your agents.`; `Add Adapter` → `Add a connection`;
`Adapter` / `Adapter ID` → `Connection` / `Connection ID`; `Adapter Tools` → `Connection tools`;
`External Integrations` → `Connections`; marketplace facet `Connectors` → `Connections`;
`or any provider` → `or any service`. Then ship Wave 2 of `vocab-gate/banned-terms.json` so it
cannot come back. Identifiers, routes and schemas stay exactly as they are — the ADR says display
copy only.

---

### [P2/L] One thing, three names: session vs conversation vs chat

**Files (representative, not exhaustive):**
`layers/features/session-list/ui/SessionsView.tsx:86`,
`layers/features/session-list/ui/EmbedSessionList.tsx:99`,
`layers/features/chat/ui/ChatEmptyState.tsx:60`,
`layers/features/command-palette/ui/AgentSubMenu.tsx:105,110`,
`layers/features/dashboard-sidebar/model/rules/build-getting-started.ts:54`,
`layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx:299,191`,
`layers/features/settings/ui/runtimes/GlobalTrustRow.tsx:123`,
`layers/features/settings/ui/runtimes/rows/ModelRow.tsx:92`,
`layers/features/onboarding/ui/SystemRequirementsStep.tsx:472,528`,
`layers/features/canvas/ui/CanvasFileContent.tsx:110`,
`layers/features/diff-review/ui/CanvasDiffContent.tsx:104`,
`layers/features/status/ui/UsageStatusItem.tsx:69,159`,
`layers/features/profile/ui/pages/SessionsPage.tsx:88,103,110`,
`layers/features/status/ui/SessionPopover.tsx:140`,
`layers/entities/binding/ui/BindingAdvancedSection.tsx:179`

**Evidence.** The same object — one working thread with one agent — is named three different ways,
often two screens apart and sometimes in one dropdown:

- **conversation**: `"No conversations yet"`, `"Start a conversation"`,
  `"Where new conversations stop for you"`, `"Which … model a new conversation starts on"`,
  `"Couldn't branch off this conversation."`, `"Search conversations"`
- **session**: `"New Session"`, `"Browse sessions…"` (same menu, `AgentSubMenu.tsx:105` and `:110`),
  `"Start your first session"` (the Getting-started checklist), `"Open a session to view files."`,
  `"Session Cost"`, `"Session"` popover title, `"Session Strategy"`
- **chat**: `"Start new chats with"` (onboarding), `"New chats will start with it."`
  (`connectedSentence`, the very next sentence a first-run user reads)

Onboarding teaches "chats". The Getting-started checklist immediately says "Start your first
session". The empty state that follows says "Start a conversation".

**Why it falls short.** Writing-for-humans rule 5, and the lens's terminology requirement. A
newcomer to AI agents has to build one mental model and is handed three labels for it inside the
first two minutes.

**Recommendation.** Pick one and write it down, in a short `decisions/` ADR so the next PR
inherits it. **"Chat"** is the recommendation: it is the shortest, the least technical, the one
onboarding already uses, and it does not collide with anything (`channel` is claimed by ADR
`260726-193526`, and `session` is a load-bearing wire/API noun that should stay in code and out of
copy). Then sweep: `"No conversations yet"` → `"No chats yet"`; `"New Session"` → `"New chat"`;
`"Start your first session"` → `"Start your first chat"`; `"Session Cost"` → `"Chat cost"`;
`"Open a session to view files."` → `"Open a chat to see its files."`;
`"Where new conversations stop for you"` → `"Where new chats stop for you"`. Add a Wave-3 entry to
`vocab-gate/banned-terms.json` for the two losers so the sweep cannot rot. Effort is **L** because
it touches ~40 render-path strings plus the deep-link/test-id assertions that quote them.

---

### [P2/M] Settings speaks in two registers, and the older one is a man page

**Files:** `layers/features/settings/ui/AdvancedTab.tsx:59-68,110-117,132-134,152-154,177-197,247`,
`layers/features/settings/ui/ToolsTab.tsx:153-154`,
`layers/features/settings/ui/tabs/AppearanceTab.tsx:48,61,79`,
`layers/features/settings/ui/external-mcp/RateLimitSection.tsx:24-25`,
`layers/features/settings/ui/tools/SchedulerSettings.tsx:26,40`,
`layers/features/settings/ui/PrivacyTab.tsx:63`
(contrast: `layers/features/settings/ui/tabs/NotificationsTab.tsx:44-84`,
`layers/features/settings/ui/WelcomeBackCard.tsx:68`)

**Evidence.** One dialog, two voices. The Notifications tab is exemplary —
`label="Knock when an agent needs you"`,
`description="A soft double-knock the moment something stops and waits for your answer."` — benefit
first, one idea per sentence, no jargon. Three tabs away:

| Current                                                                                                                                                               | Problem                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `"Poll for updates to sessions running outside DorkOS (e.g. the Claude Code CLI). Enable only if external activity isn't appearing promptly."` (`AdvancedTab.tsx:68`) | "Poll", "e.g.", "external activity", mechanism-first, 24 words |
| `"Server log verbosity"` (`:117`)                                                                                                                                     | two nouns, no verb, no actor                                   |
| `"Size in KB before a log file is rotated"` (`:134`)                                                                                                                  | passive, "rotated" undefined                                   |
| `"Number of old log files to retain (1-30)"` (`:154`)                                                                                                                 | passive, "retain"                                              |
| `"Directory where server log files are stored"` (`:247`)                                                                                                              | passive                                                        |
| `"Server log verbosity and rotation. Changes take effect immediately for log level; rotation settings apply on next file rotation."` (`:112`)                         | 20 words, two ideas, a semicolon, "rotation" three times       |
| `"Restart the DorkOS server process. Active sessions will be interrupted."` (`:197`)                                                                                  | "server process", passive second sentence                      |
| `"Server info, agent identity, app controls, and preview reads"` (`ToolsTab.tsx:154`)                                                                                 | a noun list with no verb; "preview reads" is meaningless cold  |
| `"Limit external MCP requests per time window"` (`RateLimitSection.tsx:25`)                                                                                           | MCP unglossed, "time window"                                   |
| `"Scheduled runs at once"` / `"Completed runs to keep"` (`SchedulerSettings.tsx:26,40`)                                                                               | fragments                                                      |
| `"Choose your preferred color scheme"` / `"Choose the typeface for the interface"` (`AppearanceTab.tsx:48,61`)                                                        | "so what?" — says only what the control obviously does         |
| `"Payload shown below."` (`PrivacyTab.tsx:63`)                                                                                                                        | "payload" on the privacy tab, of all places                    |

**Why it falls short.** Writing-for-humans rules 3, 4 and 5, and the `AGENTS.md` decision filter
("describe what happens for the user, not how the system works internally"). Priya will forgive it;
Ikechi cannot use it.

**Recommendation.** Rewrite the older tabs to the Notifications register. Suggested replacements:
`"Poll for updates…"` → `"Watch for agents you started somewhere else"` /
`"Turn this on if work you started in a terminal takes a while to show up here."`;
`"Server log verbosity"` → `"How much detail DorkOS writes down"`;
`"Size in KB before a log file is rotated"` → `"How big one log file gets before DorkOS starts a new one"`;
`"Number of old log files to retain (1-30)"` → `"How many old log files to keep"`;
`"Directory where server log files are stored"` → `"Where DorkOS keeps these files"`;
`"Restart the DorkOS server process. Active sessions will be interrupted."` →
`"Restart DorkOS. Anything running right now stops."`;
`"Server info, agent identity, app controls, and preview reads"` →
`"Let agents check the app, know who they are, and read what you're previewing."`;
`"Limit external MCP requests per time window"` →
`"Cap how many requests other apps can send DorkOS in a minute."`;
`"Choose your preferred color scheme"` → drop it (the control shows the choices);
`"Payload shown below."` → `"You can see exactly what gets sent below."`

---

### [P2/M] The "Failed to …" error family, and raw server errors shown verbatim

**Files:** `layers/shared/lib/query-client.ts:108,136`,
`layers/features/settings/ui/RestartDialog.tsx:33`,
`layers/features/settings/ui/ResetDialog.tsx:38`,
`layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx:297,309`,
`layers/features/session-list/ui/EmbedSidebar.tsx:71`,
`layers/features/profile/ui/pages/SessionsPage.tsx:67`,
`layers/features/extensions/ui/ExtensionsSettingsTab.tsx:47,62,70,73`,
`layers/features/extensions/ui/SettingFieldRenderers.tsx:69,127,189,238`,
`layers/features/extensions/ui/ManifestSettingsPanel.tsx:301,319`,
`layers/features/ask/ui/QuestionPrompt.tsx:155`,
`layers/features/ask/ui/ElicitationPrompt.tsx:83`,
`layers/features/settings/model/use-tunnel-actions.ts:82,106`,
`layers/shared/ui/DirectoryPicker.tsx:157`,
`layers/features/mesh/ui/TopologyGraph.tsx:278`,
`layers/features/relay/ui/MessageTrace.tsx:49`,
`layers/entities/marketplace/ui/SkillPacksList.tsx:29`,
`layers/features/status/ui/ModelSelectionList.tsx:67`,
`layers/features/dashboard-attention/ui/FailedRunDetailSheet.tsx:81`,
`layers/shared/ui/app-crash-fallback.tsx:55`

**Evidence.** Two problems, one pattern.

1. **`Failed to X` is the app's default error voice** — ~25 user-visible strings: `'Failed to
restart server'`, `'Failed to reset data'`, `'Failed to fork session'`, `'Failed to fetch the
local MCP token'`, `'Failed to rotate the local MCP token'`, `` `Failed to save ${status.label}` ``,
   `'Failed to reload extensions'`, `` `Failed to ${action} extension: ${err.message}` ``,
   `'Failed to submit answers'`, `'Failed to load topology'`, `'Failed to load trace.'`,
   `'Failed to load skills.'`, `'Failed to load models'`, `'Failed to load run details.'`,
   `'Failed to load data'` (the global default at `query-client.ts:108`). The app already knows
   the better register elsewhere: `"Couldn't branch off this conversation."`
   (`SessionSwitcher.tsx:191`), `"Couldn't send. Try the GitHub option."`
   (`use-send-feedback.ts:187`), `"Couldn't save your version"` (`use-fork-shape.ts:99`).
   None of the `Failed to` strings say what to do next.
2. **Raw errors are handed straight to the user.** The dominant idiom is
   `toast.error(err instanceof Error ? err.message : 'Failed to X')`, so the _fallback_ is the only
   authored copy and the common path shows whatever the server or Node threw. `query-client.ts:136`
   makes it app-wide: ``const line = label ? `${label} — ${error.message}` : 'Action failed. Please
try again.'``. `app-crash-fallback.tsx:55` renders the bare `error.message` as the only
   explanation on the crash screen. A user meets `ENOENT: no such file or directory, open …` with
   no gloss.

**Why it falls short.** Rule 3 (active voice with a clear actor — "Failed to" has no actor and
blames nothing), rule 5 (undefined technical terms arrive verbatim), and the "so what?" self-check
(none of these say what to do). `'Action failed. Please try again.'` also names a UI-implementation
concept ("action") rather than the thing the person did.

**Recommendation.** Three moves, all mechanical:

- Rename the family: `Failed to X` → `Couldn't X` (`"Couldn't restart DorkOS"`, `"Couldn't load
your models"`, `"Couldn't save that setting"`). Add a next step where one exists
  (`"Couldn't reach the server. Check DorkOS is still running."`).
- Change the global defaults: `query-client.ts:108` `'Failed to load data'` → `"Couldn't load
that. Try again."`; `:136` `'Action failed. Please try again.'` → `"That didn't work. Try
again."`.
- Stop leading with `err.message`. Invert the idiom so the authored sentence is always the
  headline and the raw text is the _description_ (Sonner already supports `{ description }`, which
  is what `SessionSwitcher.tsx:191` does correctly). Same for `app-crash-fallback.tsx`: keep a
  plain lead sentence and put `{message}` under a "Details" line.

---

### [P2/M] Title Case, sentence case and SHOUTED headers, all in the same product

**Files:** `layers/widgets/home/ui/PinnedTriageHeaderView.tsx:88,494,524,543`,
`layers/features/settings/ui/AdvancedTab.tsx:59,75,110,177,183,195`,
`layers/features/settings/ui/ToolsTab.tsx:153`,
`layers/features/settings/ui/RestartDialog.tsx:43`,
`layers/features/settings/ui/ResetDialog.tsx:56`,
`layers/features/settings/ui/ServerTab.tsx:78,79`,
`layers/features/settings/ui/RemoteAccessAction.tsx:22`,
`layers/features/settings/ui/external-mcp/SetupInstructions.tsx:35`,
`layers/features/tasks/ui/TaskFormInner.tsx:373,536`,
`layers/features/status/ui/UsageStatusItem.tsx:52,69,159`,
`layers/features/command-palette/ui/AgentSubMenu.tsx:89,105,110`,
`layers/features/dashboard-attention/ui/FailedRunDetailSheet.tsx:67`,
`layers/features/dashboard-attention/ui/OfflineAgentDetailSheet.tsx:82`,
`layers/features/dashboard-attention/ui/DeadLetterDetailSheet.tsx:46,95`,
`layers/features/relay/ui/ComposeMessageDialog.tsx:95`,
`layers/features/relay/ui/DeadLetterSection.tsx:106`,
`layers/features/marketplace/ui/MarketplaceSourcesView.tsx:98,177`,
`layers/widgets/control-center/ui/ControlCenter.tsx:60,63`,
`layers/entities/binding/ui/BindingAdvancedSection.tsx:179,249`,
`layers/features/agent-settings/ui/IdentityTab.tsx:282,310`,
`layers/features/dashboard-sidebar/ui/SidebarFooterMenu.tsx:211`,
`layers/shared/ui/sidebar.tsx:270,283,286`,
`router.tsx:280,281`

**Evidence.** There is no house casing rule and it shows. Two files make it vivid:

- `router.tsx:280` `title="Marketplace Sources"` sits one line above `:281`
  `title="Product feedback"`.
- `AgentSubMenu.tsx` renders `Open Here` (`:89`), `New Session` (`:105`) and `Browse sessions…`
  (`:110`) as three consecutive items in one menu.

The home surface is the worst offender because it is the first screen: `TriageGroup` headings are
`"Waiting On You"`, `"Needs Attention"`, `"Recent Activity"` (`:494,524,543`) — Title Case with a
wrongly capitalised preposition ("On") — and `TriageGroup` renders them
`text-xs font-medium tracking-widest uppercase` (`:88`). `contributing/design-system.md`
§"Zones and Sections" says the opposite in as many words: section labels are "sentence case, **11px
medium**… ALL-CAPS with letterspacing reads dated at small sizes."

**Why it falls short.** Title Case reads as marketing chrome, not as a control panel; and mixed
casing inside one menu is the kind of thing Priya notices in the first thirty seconds.

**Recommendation.** Adopt **sentence case everywhere except proper nouns** (product names,
"Claude Code", "DorkOS", "Slack") and write it into `contributing/design-system.md` beside the
section-header rule that already implies it. Then sweep: `Waiting On You` → `Waiting on you`;
`Needs Attention` → `Needs attention`; `Recent Activity` → `Recent activity` (and drop the
`uppercase tracking-widest` treatment per the design system); `Background Updates` → `Background
updates`; `Danger Zone` → `Danger zone`; `Reset All Data` → `Reset all data`; `Restart Server` →
`Restart DorkOS`; `Core Tools` → `Core tools`; `Working Directory` / `Data Directory` → `Working
folder` / `Data folder`; `New Session` → `New chat`; `Open Here` → `Open here`; `Session Strategy`
→ `Session strategy`; `Add Marketplace Source` → `Add a marketplace source`; `Toggle Sidebar` →
`Toggle sidebar`; `Dismiss Group` → `Dismiss these`.

---

### [P2/M] Message-queue jargon on the dashboard a new user lands on

**Files:** `layers/features/dashboard-attention/ui/DeadLetterDetailSheet.tsx:46,55-56,62,79,95`,
`layers/features/relay/ui/DeadLetterSection.tsx:106,132`,
`layers/features/dashboard-attention/ui/FailedRunDetailSheet.tsx:67`,
`layers/features/dashboard-attention/ui/OfflineAgentDetailSheet.tsx:82`

**Evidence.** The attention sheets that open from Home say, verbatim: `Dead Letters` (sheet
title), `{count} undeliverable message(s)`, `First seen: … ago` / `Last seen: … ago`,
`Sample payload` above a raw `JSON.stringify(...)` block, `Dismiss Group`,
`Mark dead letters as resolved?`, and `Sample Envelope` (dialog title, `DeadLetterSection.tsx:106`).
The sheet's description line is the raw `source` string, falling back to `'Unknown source'`.

**Why it falls short.** "Dead letter", "envelope", "payload" and "source" are message-broker
vocabulary. Nothing on the sheet glosses any of them, and a person who has never run a message
queue cannot tell whether this is bad, whose fault it is, or what "dismiss" does. Rule 5, plus the
"explain-back" self-check.

**Recommendation.** Retitle the whole surface in user terms: `Dead Letters` → `Messages that never
arrived`; `{n} undeliverable messages` → `{n} messages couldn't be delivered`;
`First seen`/`Last seen` → `First happened`/`Last happened`; `Sample payload` → `What one of them
looked like` (keep it collapsed by default — progressive disclosure); `Sample Envelope` → `What was
sent`; `Dismiss Group` → `Clear these`; `Mark dead letters as resolved?` → `Clear these messages?`;
`'Unknown source'` → `"We don't know where these came from"`. Add one framing sentence at the top:
`"These messages were meant for an agent and never got there. Clearing them doesn't send them."`
Same pass for `Failed Run` → `Run that didn't finish` and `Offline Agents` → `Agents that aren't
answering`.

---

### [P2/M] The topology page speaks "namespace" while its own headings say "project"

**Files:** `layers/features/mesh/ui/TopologyPanel.tsx:175,196,269-273,287,299-305`,
`layers/features/mesh/ui/TopologyLegend.tsx:81,87,99`,
`layers/features/mesh/ui/AgentsList.tsx` filter (`layers/features/agents-list/ui/AgentsList.tsx:252`)

**Evidence.** In one panel:

- heading `"Namespaces"` (`:287`) directly above heading `"Cross-Project Access Rules"` (`:299`)
- empty state headline `"Cross-project access requires multiple namespaces"` with description
  `"Register agents from different directories to create namespaces, then configure
cross-namespace access rules."` (`:271-273`)
- body `"No cross-project rules. Agents can only communicate within their own namespace."` (`:304`)
- select placeholders `"Select namespace"` (`:175`, `:196`)
- legend entries `"Relay-enabled"` and `"Scheduled tasks"` (`TopologyLegend.tsx:81,87`) — the first
  names an internal subsystem the user never chose

So the same concept is "namespace", "project" and "directory" within four lines, and the one word
the user _would_ understand ("project") is the one used only in headings.

**Why it falls short.** Rule 5 (define or drop), plus the terminology requirement. "Namespace",
"configure", "register", "communicate" and "Relay" are all developer register; the page is
reachable from the Team surface by anyone.

**Recommendation.** Standardise on **project**, since two of the three headings already do.
`"Namespaces"` → `"Projects"`; `"Select namespace"` → `"Pick a project"`;
`"Cross-project access requires multiple namespaces"` → `"You need agents in more than one project"`;
description → `"Add agents from a second folder. Then you can let the two projects talk."`;
`"No cross-project rules. Agents can only communicate within their own namespace."` →
`"No rules yet. Right now agents only talk to others in the same project."`;
`"Relay-enabled"` → `"Can message other agents"`. Code identifiers (`namespace`, `sourceNamespace`)
stay untouched, exactly as ADR `260804-021140` splits product copy from architecture vocabulary.

---

### [P2/S] "Runtime" and "Max Runtime" sit in one form meaning two unrelated things

**Files:** `layers/features/tasks/ui/TaskExecutionFields.tsx:75`,
`layers/features/tasks/ui/TaskFormInner.tsx:373,536,554`

**Evidence.** The Create-a-task form renders, in this order:

- `<Label htmlFor="schedule-runtime">Runtime</Label>` (`TaskExecutionFields.tsx:75`) — meaning
  _which agent engine_ (Claude Code / Codex / OpenCode)
- `<Label>Cron Expression</Label>` (`TaskFormInner.tsx:373`) — with a `crontab.guru` link as the
  only explanation
- `<Label htmlFor="schedule-max-runtime">Max Runtime</Label>` with `placeholder="10m"` and **no
  description** (`TaskFormInner.tsx:536`) — meaning _how long the run may last_
- `<Label htmlFor="schedule-sticky">Sticky</Label>` (`:554`) — with a good description underneath

**Why it falls short.** The same word carries two meanings eight rows apart, and neither is
glossed. "Cron expression" and "Sticky" are terms with no plain meaning; "Sticky" is rescued by its
description, "Cron Expression" and "Max Runtime" are not. Rule 5.

**Recommendation.** `Runtime` → `Agent engine` (or the ADR-safe `Runs on`); `Max Runtime` → `Stop
after`, with description `"Give up if the run takes longer than this."`; `Cron Expression` →
`Custom timing` with `"Advanced. Write a cron line, or use the presets above."`; `Sticky` →
`Remember the last run` (keep the existing description verbatim, it is good).

---

### [P2/M] Em dashes in ~109 user-facing strings, including the app-wide error toast

**Files:** `layers/shared/lib/query-client.ts:136` (the format string every failed mutation uses),
`layers/features/settings/ui/ToolsTab.tsx:147`,
`layers/features/agent-settings/ui/ToolsTab.tsx:245,335,436`,
`layers/features/status/ui/AutoModeConfirmDialog.tsx:52`,
`layers/features/feature-promos/ui/dialogs/SchedulesDialog.tsx:33`,
`layers/shared/ui/trust-dial.tsx:108`,
`layers/features/settings/ui/runtimes/GlobalTrustRow.tsx:164`,
`layers/features/settings/ui/WelcomeBackCard.tsx:75`,
`layers/features/settings/ui/tabs/NotificationsTab.tsx:61,131`,
`layers/features/connections/ui/SessionConnectorsGroup.tsx:21,22`,
plus ~95 more (`grep -rn "—" layers --include='*.tsx'` filtered to copy positions; 6 of them
spelled `&mdash;`).

**Evidence.** The writing-for-humans house rule is unambiguous: "**no em dashes.** They invite
run-on sentences that smuggle in a second idea; use a comma, colon, parentheses, or a new sentence
instead." The rule is broken about 109 times, and the single highest-traffic offender is
structural rather than authored:

```ts
// query-client.ts:136
const line = label ? `${label} — ${error.message}` : 'Action failed. Please try again.';
```

Every mutation failure in the app renders an em dash by construction. The rule's own prediction
holds in practice: `ToolsTab.tsx:147` is a 44-word sentence held together by one
(`"It is guidance, not a lock — an agent that asks for one anyway still gets it."`).

**Why it falls short.** It is a written house rule with no enforcement, so it rots by default.

**Recommendation.** Fix the structural one first: `` `${label}. ${error.message}` `` (a period, so
the two halves read as two sentences). Then sweep the authored strings, splitting where the dash
is joining two ideas and using a colon or comma where it is not. Consider adding em dash as a
`check-vocab-gate.ts` rule scoped to copy positions — it is the same mechanism, and it is the only
thing that will keep the sweep paid.

---

### [P2/S] "Runtime(s)" is never explained to the person who has to configure it

**Files:** `layers/features/settings/ui/SettingsDialog.tsx:62-63`,
`layers/features/settings/ui/runtimes/RuntimesTab.tsx:127-128`,
`layers/features/settings/ui/runtimes/rows/ModelRow.tsx:92`,
`layers/features/settings/ui/runtimes/rows/EffortRow.tsx:120`,
`layers/features/settings/ui/runtimes/GlobalTrustRow.tsx:125`,
`layers/features/settings/ui/runtimes/RuntimeCardView.tsx:47`,
`layers/features/tasks/ui/TaskExecutionFields.tsx:75`,
`layers/features/onboarding/ui/SystemRequirementsStep.tsx:518`

**Evidence.** Onboarding deliberately avoids the word — it names Claude Code, Codex and OpenCode
directly (`SystemRequirementsStep.tsx:170,175`) and only falls back to `'A runtime is connected.'`
in a degenerate branch (`:518`). The moment the user reaches Settings, the word is everywhere and
never defined: tab `label: 'Runtimes'`, `aria-label="Check runtimes again"`,
`"Leave it on Runtime's choice to let Claude Code decide."`, `"Not supported by {runtimeLabel}"`,
`"Every runtime follows this unless its card says otherwise."`,
`"Your default runtime isn't connected. New conversations can't start here."`

**Why it falls short.** Rule 5 — "Either avoid the jargon or gloss it in the same sentence." A
runtime is an architecture concept (`AgentRuntime`, ADR-0255/0310); the user's concept is "the AI
tool that does the work".

**Recommendation.** Cheapest honest fix, no rename: add one glossing sentence at the top of the
Runtimes tab — `"Runtimes are the AI tools DorkOS runs for you: Claude Code, Codex and
OpenCode."` — and drop the word from the rows that can lose it
(`"Leave it on Runtime's choice…"` → `"Leave it on Automatic to let Claude Code pick."`;
`"Not supported by {label}"` stays, it already names the tool). If a rename is on the table later,
"AI tools" is the phrase; but the gloss buys 90% of the value for an hour of work.

---

### [P2/S] A non-developer is handed a shell command with nowhere to type it

**Files:** `layers/shared/ui/FeatureDisabledState.tsx:11-27`,
`layers/widgets/tasks/ui/TasksPage.tsx:73-79`,
`layers/widgets/connections/ui/MessagingRegion.tsx:57-63`

**Evidence.** The shared primitive renders `{name} is currently disabled`, a description, and then
a bare `InlineCode` block. Its two production users:

- `name="Scheduled tasks"`, `description="Scheduled tasks run your agents on a timer. Start DorkOS
with the --tasks flag to turn them on."`, `command="dorkos --tasks"`
- `name="Messaging"`, `description="Messaging is off, so nothing outside DorkOS can reach your
agents yet. Start DorkOS with it on."`, `command="DORKOS_RELAY_ENABLED=true dorkos"`

Nothing says _where_ to type it, and the Messaging one shows an environment-variable prefix with no
explanation at all. Ikechi (the non-developer persona) is stuck here.

**Why it falls short.** Rule 4 (benefit then mechanism — this is mechanism only) and rule 5. The
component is also inconsistent with itself: `"{name} is currently disabled"` uses passive voice and
the filler word "currently".

**Recommendation.** Change the primitive's headline to `"{name} is off"`, and add an optional
`commandHint` line rendered above the code block, defaulting to `"Quit DorkOS, then start it again
in your terminal with:"`. Reword the two descriptions to lead with the benefit:
`"Scheduled tasks let your agents work on a timer, even when you're not here."` /
`"Turn on Messaging so people can reach your agents from Telegram, Slack and elsewhere."`
Add a `Copy` affordance to the code block (`CopyButton` already exists in `shared/ui`).

---

### [P2/S] The first-run error message shows the user internal config keys

**Files:** `layers/features/onboarding/model/use-onboarding.ts:109`

**Evidence.**

```ts
toast.error(`Failed to save onboarding progress (${keys})`);
```

`keys` is a join of internal onboarding state field names. This fires during the very first minutes
of the product, on the one surface where the user has the least context and the most doubt.

**Why it falls short.** Every rule: passive "Failed to", no actor, an unexplained parenthetical of
internal identifiers, and no next step. It also spends the first-impression budget the
`WelcomeStep`/`SystemRequirementsStep` copy worked to build.

**Recommendation.** `"DorkOS couldn't save where you got to in setup. You can keep going, and it
will try again."` Keep `keys` for the console/breadcrumb trail, not the toast.

---

### [P2/S] "Task", "schedule" and "run" name one thing inside one screen

**Files:** `layers/widgets/tasks/ui/TasksPage.tsx:75`,
`layers/features/tasks/ui/TasksList.tsx:99,123`,
`layers/features/tasks/ui/TaskFormInner.tsx:306,326,345,366,624`,
`layers/features/tasks/ui/TaskRunHistoryPanel.tsx:390-392,427`,
`layers/features/onboarding/ui/WelcomeStep.tsx:16`

**Evidence.** The page is `name="Scheduled tasks"`; the filter beside it is
`placeholder="Filter schedules..."` and its empty state is `"No schedules match your filters"`; the
form's collapsible section is `Schedule` while the thing being created is a Task; the history
panel's columns are `Trigger` / `Started` / `Duration` and its rows are "runs"; onboarding promises
`"Schedule tasks"`.

**Why it falls short.** Three nouns, one concept, one screen. "Trigger" as a column header is also
unglossed jargon for "what set this off".

**Recommendation.** Fix the noun to **task** on this surface (the page title and onboarding already
use it): `"Filter schedules…"` → `"Filter tasks…"`; `"No schedules match your filters"` → `"No tasks
match your filters"`; the `Schedule (optional)` section keeps its name because it genuinely names
the _timing_, not the task. `Trigger` → `Started by`.

---

### [P3/M] Two ellipsis characters, 40 vs 161

**Files (representative):** `layers/shared/ui/ConnectionStatusBanner.tsx:49`,
`layers/features/settings/ui/ServerRestartOverlay.tsx:88,89`,
`layers/features/settings/ui/RestartDialog.tsx:51`,
`layers/features/settings/ui/ResetDialog.tsx:89`,
`layers/features/composer/ui/ComposerInput.tsx:277`,
`layers/features/command-palette/ui/CommandPaletteDialog.tsx:587`,
`layers/features/ask/ui/QuestionPrompt.tsx:294,469,516`,
`layers/features/tasks/ui/TasksList.tsx:99`,
`layers/features/agents-list/ui/AgentsList.tsx:250`,
`layers/features/chat/ui/message/ThinkingBlock.tsx:51`,
`layers/features/mesh/ui/AgentHealthDetail.tsx:71`
(vs the majority style at e.g. `layers/features/command-palette/ui/AgentSubMenu.tsx:110`,
`layers/entities/marketplace/ui/SkillPacksList.tsx:25`)

**Evidence.** 161 copy strings use the ellipsis character `…`; 40 use three periods `...`. They
render at visibly different widths and the split is not by surface — `ConnectionStatusBanner.tsx:49`
mixes registers inside one component (`'Server link lost. Check your network.'` beside
`` `Reconnecting...${attemptText}` ``).

**Recommendation.** Standardise on `…` (the majority, and the typographically correct mark) and
sweep the 40. A one-line `check-vocab-gate` style rule keeps it fixed.

---

### [P3/M] Two apostrophes, 53 straight vs 40 curly

**Files (representative):** straight `&apos;` at
`layers/features/settings/ui/AdvancedTab.tsx:228`,
`layers/features/settings/ui/ServerTab.tsx:222`,
`layers/features/settings/ui/tabs/RoomsTab.tsx:114`,
`layers/features/settings/ui/TunnelSetup.tsx:34,81`,
`layers/features/session-list/ui/SessionListWarningNotice.tsx:54`,
`layers/features/auth/ui/ApiKeysSection.tsx:144`;
curly `’`/`&rsquo;` at
`layers/features/settings/ui/tabs/NotificationsTab.tsx:131`,
`layers/features/settings/ui/ExperimentsTab.tsx:82`,
`layers/features/settings/ui/runtimes/RuntimeCardView.tsx:43,47`,
`layers/features/tasks/ui/TaskAgentField.tsx:107,125`,
`layers/features/chat/ui/ChatEmptyState.tsx:45`,
`layers/features/settings/ui/ToolsTab.tsx:146,210`

**Evidence.** 53 strings render a straight `'` (via `&apos;`), 40 render a curly `’` (via `&rsquo;`
or the literal character). Two Settings tabs disagree with each other, and `AdvancedTab.tsx:228`
and `ServerTab.tsx:222` render the identical string `Couldn&apos;t copy` straight while
`ChatEmptyState.tsx:45` renders `couldn&rsquo;t say hello` curly.

**Recommendation.** Pick curly `’` (it is what the newest, best copy uses and what reads as
typeset) and sweep. Prefer the literal character over the entity so future greps for a phrase find
it.

---

### [P3/S] Paired empty-state lines disagree about ending in a period

**Files:** `layers/features/chat/ui/ChatEmptyState.tsx:44-48,59-61`,
`layers/features/session-list/ui/SessionsView.tsx:86`,
`layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx:299`,
`layers/features/marketplace/ui/InstalledPackagesView.tsx:223-224`,
`layers/features/marketplace/ui/MarketplaceSourcesView.tsx:200`

**Evidence.** One component, two conventions:

```tsx
// ChatEmptyState.tsx:44-48  (greeting-failed branch)
<p>{name} couldn’t say hello just now</p>          // no period
<p>Send a message to get started.</p>              // period

// ChatEmptyState.tsx:59-61  (generic branch)
<p>Start a conversation</p>                        // no period
<p>Type a message below to begin</p>               // no period
```

Elsewhere: `"No conversations yet"` (no period) vs `"No packages installed"` + `"Browse the
marketplace to discover and install your first package."` (period on the sub-line only) vs
`"No sources configured"` (no period).

**Recommendation.** Write the rule down: **headline no period, supporting sentence gets a period.**
That matches the majority and the design system's "whitespace before rules" instinct. Fix
`ChatEmptyState.tsx:61` → `"Type a message below to begin."` and sweep the handful of others.

---

### [P3/S] The three crash/error fallbacks each invent their own recovery wording

**Files:** `layers/shared/ui/app-crash-fallback.tsx:45,103,121`,
`layers/shared/ui/route-error-fallback.tsx:46,52,84,90,93`,
`layers/shared/ui/not-found-fallback.tsx:11,13,17`

**Evidence.** Three sibling fallbacks, three vocabularies:

|             | Headline                                  | Recovery button                         |
| ----------- | ----------------------------------------- | --------------------------------------- |
| App crash   | `DorkOS encountered an unexpected error.` | `Reload DorkOS` + `Report this crash`   |
| Route error | `Something went wrong`                    | `Reload app` / `Retry` + `Back to Home` |
| 404         | `Page not found`                          | `Back to Home`                          |

"Reload DorkOS" vs "Reload app" is the same action under two names; "Back to Home" is Title Case
against sentence-case siblings; `"DorkOS encountered an unexpected error."` is the only headline
that ends in a period and the only one using a formal verb.

**Recommendation.** One vocabulary across the three: headline `"Something went wrong"` /
`"DorkOS ran into a problem"` / `"Page not found"` (no periods); buttons `Reload DorkOS`,
`Try again`, `Back to home`, `Report this`. Also give the route-error case a next step — `"Something
went wrong"` followed by a raw `error.message` (`:54`) tells the user nothing they can act on.

---

### [P3/S] Two screen-reader announcements about the same prompt use different voices

**Files:** `layers/features/ask/ui/ApprovalPrompt.tsx:263-267`

**Evidence.** One ternary chain produces three announcements for the same countdown:

```
'Nobody answered. The agent is waiting for you.'   // plain, actor named
'Urgent: 1 minute to approve or deny.'             // telegraphic
'Tool approval required. 2 minutes remaining.'     // passive, "Tool approval" undefined
```

**Why it falls short.** The third is passive with no actor and names a concept ("tool approval") the
visible card never uses. A screen-reader user gets the least plain sentence of the three at the
moment they have the most time to act on it.

**Recommendation.** Match the first line's voice throughout: `"Two minutes left to answer."` /
`"One minute left to answer."` / `"Nobody answered. The agent is waiting for you."`

---

### [P3/S] `ElicitationPrompt` says things nobody says

**Files:** `layers/features/ask/ui/ElicitationPrompt.tsx:161,179,83`

**Evidence.** The card reads `{agent} requests input`, its confirm button says `I authorized it`,
and its failure path sets `'Failed to submit'`.

**Why it falls short.** "Requests input" and "authorized" are form-speak; the neighbouring
`ApprovalCard` already speaks plainly (`'Changes things'`, `'Cannot be undone'`,
`ApprovalCard.tsx:27-28`). "I authorized it" is also past tense for an action the user is about to
take.

**Recommendation.** `{agent} needs something from you`; button `Done`; error
`"Couldn't send your answer. Try again."`

---

### [P3/S] Small stragglers worth folding into whichever sweep touches them

**Files:** `layers/features/marketplace/ui/MarketplaceSourcesView.tsx:105,200`,
`layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx:116,252`,
`layers/features/marketplace/ui/PackageDetailSheet.tsx:477`,
`layers/features/extensions/ui/ExtensionsSettingsTab.tsx:70`,
`layers/features/agent-settings/ui/ConventionFileEditor.tsx:81`,
`layers/features/settings/ui/RemoteAccessAction.tsx:22`

**Evidence and fixes:**

- `<Label htmlFor="source-url">Git URL</Label>` → `Repository link` (and a placeholder showing one).
- `"No sources configured"` → `"No marketplaces added yet"` ("configured" is dev register).
- `No auth` / `No token` chips → `Not protected` / `No key yet`.
- `"Permissions & Effects"` → `"What this can do"` (the section below it already says
  `"What this package will do"` — `PermissionPreviewSection.tsx:250`, so the heading duplicates it
  in worse words).
- `` `Reloaded ${updated.length} extension(s)` `` → `"Reloaded 3 extensions"` / `"Reloaded 1
extension"` — the `(s)` shortcut is visible sloppiness and the codebase already pluralises
  properly elsewhere (`DeadLetterDetailSheet.tsx:55`).
- `placeholder={enabled ? 'Write markdown content...' : 'Toggle on to enable injection'}` →
  `"Turn this on to use it"` — "injection" is internals.
- `<span className="flex-1">Remote Access</span>` → `Remote access`.
