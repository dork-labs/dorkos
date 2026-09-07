[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 10 — Copy: typography and stragglers

**Priority P3 · 7 findings · 5S · 2M**
**Scope:** one mechanical sweep PR. Low risk, high polish-per-line; best done after batches 8 and 9 so the sweeps do not collide.

### 10.1 — Two ellipsis characters, 40 vs 161

**P3 · M · lens 7**
Representative: `layers/shared/ui/ConnectionStatusBanner.tsx:49`, `settings/ui/ServerRestartOverlay.tsx:88,89`, `RestartDialog.tsx:51`, `ResetDialog.tsx:89`, `composer/ui/ComposerInput.tsx:277`, `command-palette/ui/CommandPaletteDialog.tsx:587`, `ask/ui/QuestionPrompt.tsx:294,469,516`, `tasks/ui/TasksList.tsx:99`, `agents-list/ui/AgentsList.tsx:250`, `chat/ui/message/ThinkingBlock.tsx:51`

**Evidence.** 161 copy strings use `…`; 40 use three periods. They render at visibly different widths and the split is not by surface — `ConnectionStatusBanner.tsx:49` mixes both registers inside one component.

**Recommendation.** Standardise on `…` (the majority, and typographically correct) and sweep the 40. A one-line `check-vocab-gate` rule keeps it fixed.

### 10.2 — Two apostrophes, 53 straight vs 40 curly

**P3 · M · lens 7**
Straight `&apos;`: `settings/ui/AdvancedTab.tsx:228`, `ServerTab.tsx:222`, `tabs/RoomsTab.tsx:114`, `TunnelSetup.tsx:34,81`, `session-list/ui/SessionListWarningNotice.tsx:54`, `auth/ui/ApiKeysSection.tsx:144`. Curly: `tabs/NotificationsTab.tsx:131`, `ExperimentsTab.tsx:82`, `runtimes/RuntimeCardView.tsx:43,47`, `tasks/ui/TaskAgentField.tsx:107,125`, `chat/ui/ChatEmptyState.tsx:45`, `settings/ui/ToolsTab.tsx:146,210`

**Evidence.** Two Settings tabs disagree with each other: `AdvancedTab.tsx:228` and `ServerTab.tsx:222` render the identical string `Couldn&apos;t copy` straight, while `ChatEmptyState.tsx:45` renders `couldn&rsquo;t say hello` curly.

**Recommendation.** Pick curly `’` — it is what the newest, best copy uses and what reads as typeset — and sweep. Prefer the literal character over the HTML entity so a future grep for a phrase finds it.

### 10.3 — Paired empty-state lines disagree about ending in a period

**P3 · S · lens 7**
`apps/client/src/layers/features/chat/ui/ChatEmptyState.tsx:44-48,59-61`, `session-list/ui/SessionsView.tsx:86`, `dashboard-sidebar/ui/SessionSwitcher.tsx:299`, `marketplace/ui/InstalledPackagesView.tsx:223-224`, `MarketplaceSourcesView.tsx:200`

**Evidence.** One component, two conventions: the greeting-failed branch renders a headline with no period and a supporting line with one; the generic branch renders both with none. Elsewhere: `"No conversations yet"` (none) vs `"No packages installed"` + `"Browse the marketplace to discover and install your first package."` (period on the sub-line only) vs `"No sources configured"` (none).

**Recommendation.** Write the rule down: **headline no period, supporting sentence gets a period.** That matches the majority. Fix `ChatEmptyState.tsx:61` → `"Type a message below to begin."` and sweep the handful of others.

### 10.4 — Three crash and error fallbacks each invent their own recovery wording

**P3 · S · lens 7**
`apps/client/src/layers/shared/ui/app-crash-fallback.tsx:45,103,121`, `route-error-fallback.tsx:46,52,84,90,93`, `not-found-fallback.tsx:11,13,17`

**Evidence.** Three siblings, three vocabularies:

|             | Headline                                  | Recovery button                         |
| ----------- | ----------------------------------------- | --------------------------------------- |
| App crash   | `DorkOS encountered an unexpected error.` | `Reload DorkOS` + `Report this crash`   |
| Route error | `Something went wrong`                    | `Reload app` / `Retry` + `Back to Home` |
| 404         | `Page not found`                          | `Back to Home`                          |

"Reload DorkOS" and "Reload app" are the same action under two names; "Back to Home" is Title Case against sentence-case siblings; the crash headline is the only one ending in a period and the only one using a formal verb.

**Recommendation.** One vocabulary across the three: headlines `"DorkOS ran into a problem"` / `"Something went wrong"` / `"Page not found"` (no periods); buttons `Reload DorkOS`, `Try again`, `Back to home`, `Report this`. Also give the route-error case a next step — a headline followed by a raw `error.message` tells the user nothing they can act on.

### 10.5 — Two screen-reader announcements about the same prompt use different voices

**P3 · S · lens 7**
`apps/client/src/layers/features/ask/ui/ApprovalPrompt.tsx:263-267`

**Evidence.** One ternary chain produces three announcements for one countdown: `'Nobody answered. The agent is waiting for you.'` (plain, actor named), `'Urgent: 1 minute to approve or deny.'` (telegraphic), `'Tool approval required. 2 minutes remaining.'` (passive, and "tool approval" is a concept the visible card never uses). A screen-reader user gets the least plain sentence at the moment they have the most time to act.

**Recommendation.** Match the first line's voice throughout: `"Two minutes left to answer."` / `"One minute left to answer."` / `"Nobody answered. The agent is waiting for you."`

### 10.6 — `ElicitationPrompt` says things nobody says

**P3 · S · lens 7**
`apps/client/src/layers/features/ask/ui/ElicitationPrompt.tsx:83,161,179`

**Evidence.** The card reads `{agent} requests input`, its confirm button says `I authorized it`, and its failure path sets `'Failed to submit'`. The neighbouring `ApprovalCard` already speaks plainly (`'Changes things'`, `'Cannot be undone'`). "I authorized it" is also past tense for an action the user is about to take.

**Recommendation.** `{agent} needs something from you`; button `Done`; error `"Couldn't send your answer. Try again."`

### 10.7 — Small stragglers worth folding into whichever sweep touches them

**P3 · S · lens 7**
`apps/client/src/layers/features/marketplace/ui/MarketplaceSourcesView.tsx:105,200`, `settings/ui/external-mcp/ExternalMcpCard.tsx:116,252`, `marketplace/ui/PackageDetailSheet.tsx:477`, `extensions/ui/ExtensionsSettingsTab.tsx:70`, `agent-settings/ui/ConventionFileEditor.tsx:81`, `settings/ui/RemoteAccessAction.tsx:22`

**Evidence and fixes.**

- `<Label>Git URL</Label>` → `Repository link` (with a placeholder showing one).
- `"No sources configured"` → `"No marketplaces added yet"` ("configured" is dev register).
- `No auth` / `No token` chips → `Not protected` / `No key yet`.
- `"Permissions & Effects"` → `"What this can do"` — the section below it already says `"What this package will do"` (`PermissionPreviewSection.tsx:250`), so the heading duplicates it in worse words.
- `` `Reloaded ${updated.length} extension(s)` `` → proper pluralisation; the codebase already does this correctly at `DeadLetterDetailSheet.tsx:55`.
- `placeholder={enabled ? 'Write markdown content...' : 'Toggle on to enable injection'}` → `"Turn this on to use it"` — "injection" is internals.
- `<span>Remote Access</span>` → `Remote access`.
