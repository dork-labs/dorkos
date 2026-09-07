[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 8 — Copy: honesty and settled vocabulary

**Priority P1 · 7 findings · 4S · 2M · 1L**
**Scope:** strings that misdescribe risk, or that name one concept several ways. 8.3 is spec-sized (~40 render-path strings plus test-id assertions); the rest are sweeps within one feature each. Identifiers, routes and schemas stay untouched throughout — this is display copy only, exactly as ADR `260804-021140` splits it.

### 8.1 — The riskiest permission setting describes itself like the safe one

**P1 · S · lens 7**
`apps/client/src/layers/shared/ui/trust-dial.tsx:100-109` (rendered at `:339`), `apps/client/src/layers/shared/ui/unattended-autonomy-dialog.tsx:96`, `apps/client/src/layers/features/status/ui/AutonomyConfirmDialog.tsx:167`, `apps/client/src/layers/shared/ui/consent-ritual-copy.ts:66`

**Evidence.** Verified in source. Two adjacent stops:

- `act` (`asks: 'when-risky'`) — `"Gets on with the work and stops for the risky parts."`
- `autonomy` (`asks: 'never'`) — `"Acts without stopping for approval — still asks when it matters."`

Read cold, those say the same thing: _it works on its own and asks about the risky bits_. The machine claims are opposites. The dial renders `current.promise` directly under the segmented control, and the same sentence is what `UnattendedAutonomyDialog` shows as its `AlertDialogDescription` — the consent moment for an agent that will act unattended. `consent-ritual-copy.ts:66` deliberately withholds the honest line (`"This stop never pauses to ask. Whatever it decides to do, it does."`) at exactly this stop, reasoning that "the title is the promise" — but the title is only the two words "Full autonomy", and the sentence under it walks the promise back. AGENTS.md: "Be honest by design: no dark patterns." The one caption where understating risk costs the user something is the one that understates it. It also carries an em dash, against the house rule.

**Recommendation.** Replace the autonomy `promise` with a sentence that names the difference and carries no hedge: `"Acts on its own. It will not stop to ask you, even for risky steps."` Keep `FullPowerDoor.tsx:54`'s longer nuance where there is room; a 60-character dial caption is not that place. Then reconsider whether `consentAsksNote` should still return `null` for autonomy once the title's sentence is honest.

### 8.2 — Words an accepted ADR retired from user-facing copy are still on screen

**P1 · M · lens 7**
`apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx:63,66,70`, `layers/features/mesh/ui/AdapterNode.tsx:168,171`, `layers/entities/binding/ui/BindingDialog.tsx:280,296`, `layers/features/relay/ui/wizard/ConfirmStep.tsx:42`, `layers/features/relay/ui/adapter/AdapterCardHeader.tsx:64`, `layers/features/agent-settings/ui/ContextTab.tsx:207-208`, `layers/features/agent-settings/ui/ToolsTab.tsx:419-420`, `layers/features/marketplace/ui/MarketplaceSidebar.tsx:206`, `layers/entities/runtime/config/runtime-descriptors.ts:80`

**Evidence.** ADR `260804-021140` (accepted, current, "this is the last rename") retires `integration`, `connector`, `adapter` and `provider` as user-facing nouns. All four are still rendered:

| Current string                                                                                                                                                | File                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Add Integration`, `Relay routes messages between your agents and external platforms.`, `Add your first integration to start sending and receiving messages.` | `RelayEmptyState.tsx:70,63,66`        |
| `Add Adapter` / `aria-label="Add adapter"`                                                                                                                    | `AdapterNode.tsx:171,168`             |
| `<Label>Adapter</Label>`, `placeholder="Select an adapter"`                                                                                                   | `BindingDialog.tsx:280,296`           |
| `Adapter ID`                                                                                                                                                  | `wizard/ConfirmStep.tsx:42`           |
| `aria-label="Adapter actions"`                                                                                                                                | `AdapterCardHeader.tsx:64`            |
| `label="Adapter Tools"` / `"External platform subjects, adapter management, and binding routing conventions."`                                                | `ContextTab.tsx:207-208`              |
| `label: 'External Integrations'` / `'Manage integrations with Slack, Telegram, and other platforms'`                                                          | `agent-settings/ToolsTab.tsx:419-420` |
| `label="Connectors"` (marketplace facet)                                                                                                                      | `MarketplaceSidebar.tsx:206`          |
| `subtitle: 'Your own models, local or any provider'`                                                                                                          | `runtime-descriptors.ts:80`           |

Meanwhile the same feature's toasts already speak the new vocabulary — `IntegrationsTab.tsx:124,153,166` fire `'Connection added'`, `'Connection removed'`, `'Connection paused'`. One screen calls the thing four names. `scripts/check-vocab-gate.ts` exists to stop exactly this and has only shipped Wave 1 ("connection"); its own header names these four as the planned Wave 2, which never landed.

**Recommendation.** Sweep to the ADR's vocabulary — **Connections** (umbrella), **Messaging** (the Relay region), **Accounts** (the ConnectorProvider region). Concretely: `Add Integration` → `Add a connection`; `Relay routes messages between…` → `Connections let people and platforms reach your agents.`; `Add Adapter` → `Add a connection`; `Adapter`/`Adapter ID` → `Connection`/`Connection ID`; `Adapter Tools` → `Connection tools`; `External Integrations` → `Connections`; the marketplace facet `Connectors` → `Connections`; `or any provider` → `or any service`. Then ship Wave 2 of `vocab-gate/banned-terms.json` so it cannot come back.

### 8.3 — One thing, three names: session vs conversation vs chat

**P2 · L · lens 7**
Representative: `layers/features/session-list/ui/SessionsView.tsx:86`, `EmbedSessionList.tsx:99`, `layers/features/chat/ui/ChatEmptyState.tsx:60`, `layers/features/command-palette/ui/AgentSubMenu.tsx:105,110`, `layers/features/dashboard-sidebar/model/rules/build-getting-started.ts:54`, `layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx:191,299`, `layers/features/settings/ui/runtimes/GlobalTrustRow.tsx:123`, `layers/features/settings/ui/runtimes/rows/ModelRow.tsx:92`, `layers/features/onboarding/ui/SystemRequirementsStep.tsx:472,528`, `layers/features/canvas/ui/CanvasFileContent.tsx:110`, `layers/features/status/ui/UsageStatusItem.tsx:69,159`, `layers/features/profile/ui/pages/SessionsPage.tsx:88,103,110`, `layers/features/status/ui/SessionPopover.tsx:140`

**Evidence.** The same object — one working thread with one agent — carries three names, sometimes in one dropdown:

- **conversation**: `"No conversations yet"`, `"Start a conversation"`, `"Where new conversations stop for you"`, `"Couldn't branch off this conversation."`, `"Search conversations"`
- **session**: `"New Session"` and `"Browse sessions…"` in the same menu (`AgentSubMenu.tsx:105` and `:110`), `"Start your first session"`, `"Open a session to view files."`, `"Session Cost"`, `"Session Strategy"`
- **chat**: `"Start new chats with"` (onboarding), `"New chats will start with it."` (the very next sentence a first-run user reads)

Onboarding teaches "chats". The Getting-started checklist immediately says "Start your first session". The empty state that follows says "Start a conversation". A newcomer to agents has to build one mental model and is handed three labels for it inside the first two minutes.

**Recommendation.** Pick one and write it into a short ADR so the next PR inherits it. **"Chat"** is the recommendation: shortest, least technical, already used by onboarding, and it collides with nothing (`channel` is claimed by ADR `260726-193526`; `session` is a load-bearing wire/API noun that should stay in code and out of copy). Then sweep: `"No conversations yet"` → `"No chats yet"`; `"New Session"` → `"New chat"`; `"Start your first session"` → `"Start your first chat"`; `"Session Cost"` → `"Chat cost"`; `"Open a session to view files."` → `"Open a chat to see its files."`. Add a Wave-3 entry to `vocab-gate/banned-terms.json` for the two losers. Effort is **L** because it touches ~40 render-path strings plus the deep-link and test-id assertions that quote them.

### 8.4 — "Task", "schedule" and "run" name one thing inside one screen

**P2 · S · lens 7**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:75`, `layers/features/tasks/ui/TasksList.tsx:99,123`, `TaskFormInner.tsx:306,326,345,366,624`, `TaskRunHistoryPanel.tsx:390-392,427`, `layers/features/onboarding/ui/WelcomeStep.tsx:16`

**Evidence.** The page is `name="Scheduled tasks"`; the filter beside it is `placeholder="Filter schedules..."` with the empty state `"No schedules match your filters"`; the form's collapsible section is `Schedule` while the thing being created is a Task; the history panel's rows are "runs" under a `Trigger` column; onboarding promises `"Schedule tasks"`. Three nouns, one concept, one screen — and "Trigger" is unglossed jargon for "what set this off".

**Recommendation.** Fix the noun to **task** on this surface (the page title and onboarding already use it): `"Filter schedules…"` → `"Filter tasks…"`; `"No schedules match your filters"` → `"No tasks match your filters"`. The `Schedule (optional)` section keeps its name — it genuinely names the _timing_, not the task. `Trigger` → `Started by`.

### 8.5 — The topology page says "namespace" while its own headings say "project"

**P2 · M · lens 7**
`apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx:175,196,269-273,287,299-305`, `layers/features/mesh/ui/TopologyLegend.tsx:81,87,99`

**Evidence.** In one panel: the heading `"Namespaces"` sits directly above the heading `"Cross-Project Access Rules"`; the empty state reads `"Cross-project access requires multiple namespaces"` with the description `"Register agents from different directories to create namespaces, then configure cross-namespace access rules."`; the body reads `"No cross-project rules. Agents can only communicate within their own namespace."`; the select placeholders say `"Select namespace"`. So one concept is "namespace", "project" and "directory" within four lines, and the one word a user would understand is the one used only in headings. The legend entry `"Relay-enabled"` names an internal subsystem the user never chose.

**Recommendation.** Standardise on **project**, since two of the three headings already do. `"Namespaces"` → `"Projects"`; `"Select namespace"` → `"Pick a project"`; the empty-state headline → `"You need agents in more than one project"`; its description → `"Add agents from a second folder. Then you can let the two projects talk."`; the body → `"No rules yet. Right now agents only talk to others in the same project."`; `"Relay-enabled"` → `"Can message other agents"`. Code identifiers (`namespace`, `sourceNamespace`) stay untouched.

### 8.6 — "Runtime" and "Max Runtime" sit in one form meaning two unrelated things

**P2 · S · lens 7**
`apps/client/src/layers/features/tasks/ui/TaskExecutionFields.tsx:75`, `layers/features/tasks/ui/TaskFormInner.tsx:373,536,554`

**Evidence.** The create-a-task form renders, in order: `<Label>Runtime</Label>` meaning _which agent engine_; `<Label>Cron Expression</Label>` with a crontab.guru link as its only explanation; `<Label>Max Runtime</Label>` with `placeholder="10m"` and **no description**, meaning _how long the run may last_; and `<Label>Sticky</Label>`, which has a good description. The same word carries two meanings eight rows apart, and neither is glossed.

**Recommendation.** `Runtime` → `Agent engine` (or the ADR-safe `Runs on`); `Max Runtime` → `Stop after`, with `"Give up if the run takes longer than this."`; `Cron Expression` → `Custom timing` with `"Advanced. Write a cron line, or use the presets above."`; `Sticky` → `Remember the last run`, keeping its existing description verbatim.

### 8.7 — "Runtime(s)" is never explained to the person who has to configure it

**P2 · S · lens 7**
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:62-63`, `layers/features/settings/ui/runtimes/RuntimesTab.tsx:127-128`, `rows/ModelRow.tsx:92`, `rows/EffortRow.tsx:120`, `GlobalTrustRow.tsx:125`, `RuntimeCardView.tsx:47`

**Evidence.** Onboarding deliberately avoids the word — it names Claude Code, Codex and OpenCode directly and only falls back to `'A runtime is connected.'` in a degenerate branch. The moment the user reaches Settings the word is everywhere and never defined: tab `label: 'Runtimes'`, `aria-label="Check runtimes again"`, `"Leave it on Runtime's choice to let Claude Code decide."`, `"Every runtime follows this unless its card says otherwise."`, `"Your default runtime isn't connected."` A runtime is an architecture concept (ADR-0255/0310); the user's concept is "the AI tool that does the work".

**Recommendation.** Cheapest honest fix, no rename: one glossing sentence at the top of the Runtimes tab — `"Runtimes are the AI tools DorkOS runs for you: Claude Code, Codex and OpenCode."` — and drop the word from the rows that can lose it (`"Leave it on Runtime's choice…"` → `"Leave it on Automatic to let Claude Code pick."`). If a rename is later on the table, "AI tools" is the phrase; the gloss buys most of the value for an hour.
