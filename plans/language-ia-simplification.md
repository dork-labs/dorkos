# Language & IA Simplification Program

> Status: **approved by Dorian, 2026-08-03.** Adversarial critique: 2 rounds, verdict AGREE.
> Brief (HTML): https://claude.ai/code/artifact/541968c6-53e4-4123-8b56-f941c56cc319
> This file is the canonical implementation reference for the program. The Wave 2 ADR will record the naming decision permanently; this plan lands in-repo with the Wave 0 PR.

Status: critic verdict AGREE (round 2). This is the canonical plan for the HTML brief and Phase 4 implementation. Self-contained.

## Principles

- P1 Name what the user does, not how the system works.
- P2 One concept, one word; one word, one concept.
- P3 Top-level nouns are the complexity budget; nothing new gets added.
- P4 Brand names beat category nouns (Claude Code > any label above it).
- P5 Plumbing is invisible until summoned.
- P6 A word may be scoped to an audience domain (cockpit chrome / marketplace-author / architecture), with a falsifiable test: **a scoped word is legitimate only if the two domains never render in the same viewport.** Cross-domain bridges are explicit.

## Decisions

### D0 — Fix the "agent" overload first

**Invariant:** bare "agent" in user copy resolves to exactly one sense — a named teammate in your fleet (DorkBot, security-auditor…). The runtime sense uses brand names (Claude Code / Codex / OpenCode) — no category noun at all on first-run surfaces (not "engine", not "coding agent" where avoidable). The SDK-subagent sense uses "subagent" consistently.
**Acceptance test:** sweep user-facing strings; every bare "agent" must be fleet-sense; runtime-sense = brand names; subagent surfaces (SubagentBlock, SubagentsItem, BackgroundTaskBar aria-label "N more agents running" → "1 more subagent running" / "N more subagents running") use "subagent".
Known sites (not exhaustive — the invariant governs): onboarding ProgressCard, whose row opens Runtimes — **renamed to "Connect more runtimes" (DOR-853, shipped); that string is the runtime-sense answer and must not be swept back toward "agent"**; SystemRequirementsStep "Connect your first agent" / "DorkOS drives coding agents" / "Looking for coding agents on your machine" / "1 more agent available" / "An agent is connected"; RuntimeSetupDialog "more agents available"; RuntimesTab "DorkOS speaks three agent runtimes"; status-bar-registry "Which agent runtime runs this session".
The evidence line for the ADR **was** two sidebar cards shipping the identical string "Add more agents" for two different concepts: ProgressCard's row (runtime sense) and AgentOnboardingCard's (fleet sense). Both halves are now settled and neither is a live worksite: ProgressCard was renamed, and **AgentOnboardingCard was deleted outright in DOR-1138** — it hung off an empty-Library branch reachable only before the fleet query answered or while it failed, so it flashed on cold loads instead of greeting anyone on day one; day-one guidance is the sidebar's Getting started zone. One card is left, so the collision is impossible by construction; what still needs guarding is the rename, and `apps/client/src/__tests__/agent-overload-sweep.test.tsx` mounts the real ProgressCard to do it.

### D1 — Channels means conversations; kill the platform-sense residue

Keep sidebar Channels/DMs + /channels untouched. Remove platform-sense "channel" from user copy: BindingDialog "Channel Type" field + bare "Channel" option + "Chat ID" helper; Slack manifest "Channel Overrides" + respond-mode descriptions; site features.ts relay + mesh-topology cards; docs relay-messaging.mdx, tool-approval.mdx. Platform-qualified forms ("Slack channel") allowed where the platform is named in the same breath. Enum/wire values unchanged. Option-label mapping for dm|group|channel|thread designed in Phase 3. e2e POMs update in the same PR as each string.

### D2 — "Connections" is the single umbrella for the outside world

**The payment (ships Wave 1, before the flip):** "Connection" stops meaning network health in all user copy. Files: ConnectionStatusBanner, SessionInspector Row "Connection", CONNECTION_STATE_CONFIG + ConnectionItem hover prose, wizard TestStep "Connection successful/failed", classify-transport-error "Connection failed", TunnelError "Connection failed", tunnel-utils "Connection timed out/refused" (~8 files). Replacement family: "Server link" / "Live stream" / "Reachable" / "Test passed — reachable in {ms}ms" (final copy Phase 3). **Gate:** a pinned script (modeled on assert-tests-executed.sh) checks quoted user-facing strings in render paths + copy configs — not identifiers (ConnectionState type, React Flow Connection, use-sse-connection keep their names per D6).
**The page:** one page, one nav noun, two named regions with distinct verbs and consent stories:

- **Messaging** — "Where people and platforms reach your agents." Telegram/Slack/Webhook tiles → AdapterSetupWizard. Consent = who-may-DM, approver lists, chat filters. "Deliver to Claude Code" + max sessions + timeout live here as region policy: "When messages arrive".
- **Accounts** — "Services your agents can act on for you." Gmail/GitHub/Notion… tiles → OAuth ConnectDialog, custody-disclosure step untouched. Provider setup (Composio/Nango) appears in-flow when required + under Advanced disclosure. Slack account-access is Composio-only (ADR 260729 §5) and says so at the fork. Fresh install: region renders an honest designed state (tiles greyed-with-reason or setup card) — never vanishes. No dependency on the counsel-gated vendor catalog (DOR-750).
- Dual-nature services: promote ConnectDialog's existing recommendation fork to a designed intent step ("Chat with your agents in Slack" vs "Let agents act on your Slack account").
  **Surface consolidation:** delete the ?relay=open dialog (currently titled "Connections" with body "Active Integrations"); ?relay redirects to /connections?region=messaging (query param, matching app conventions — no hash). Its extra depth (bindings list, event log) moves to page/detail sheet. Palette "Integrations" entry retargets to /connections + aliases (integrations, connectors, adapters, telegram, slack, webhook, gmail). Promo CTA "Set up adapters" → "Connect Telegram & Slack" → /connections. AgentsPage onOpenAdapterCatalog retargets. e2e RelayPage.ts rewritten.
  **Deep links:** resolveSettingsTab gains a route-target escape hatch; settings=integrations|channels → /connections; openSettings('integrations') call sites retargeted; relay tour retargeted with new anchors; unknown-id silent fallback to Appearance fixed.
  **Renames (same wave as tab deletion — no interregnum):** per-agent accordion "Integrations"→"Connections"; session inspector "Connectors"→"Connections"; origin badge "Integration"→"Connection"; "Add/Edit Integration"→"Add/Edit connection"; "Remove adapter"→"Remove connection"; onboarding WelcomeStep "Connect integrations" reworded; ProgressCard gains the deliberately-withheld "Connect a service" row.
  **Retired from cockpit chrome:** integration, connector, adapter, provider ("provider" survives in OpenCode model-provider picker + summoned plumbing cards).
  **Docs:** docs/connectors/ → docs/connections/ with redirects; docs/integrations/ scoped explicitly to builders (or → docs/build/); glossary updated; meta.json ordering; sidebar-settings guide; stale SidebarNavHeader TSDoc. Icon: Cable → Plug (Phase 3 confirms).
  **ADR:** new ADR supersedes the Integration half of 260726-193526 (Channel half stands), confirms 260729's Connections, and records the finality rationale: prior renames failed because the network sense coexisted; this one removes the collision's other party.

### D3 — Runtimes keep their name; first-run never says it

"Runtimes" stays as the configuration-surface word (Settings tab, per-agent Config row, docs). NOT "Harnesses" (dorkos harness sync targets a superset incl. Cursor/Copilot/Gemini CLI that cannot run sessions — renaming would create a new collision; "harness" is engineering jargon, Conductor the lone user-facing exception). NOT "Coding Agents" (fleet collision). First-run surfaces use brand names only (D0).

### D4 — Settings shrinks, groups, and stays honest

- Delete Integrations tab (→ Connections page) and Agents tab (Default agent moves to the Agents page ONLY — fleet already shows a "Default" badge; add "Set as default" to the agent row/management menu).
- Dialog title "App Settings" → "Settings".
- Grouped nav — 10 tabs, 5 groups: (ungrouped) Appearance, Preferences · **Agents & sessions:** Tools, Runtimes · **Access & privacy:** Security, Privacy & Data, DorkOS account · **System:** Server, Advanced · **Add-ons:** Extensions + contributed tabs. **Remote Access stays a footer extra outside the groups** (it opens a dialog, not a panel — grouping it would lie about affordance).
- Tool-inventory relabels (in-chrome subsystem brands out): "Relay (Messaging)" → "Messaging", "Mesh (Discovery)" → "Agent discovery", "Relay Adapters" → "Connection management", descriptions rewritten plain; "Tasks (Scheduling)" reviewed for style consistency (final copy Phase 3).
- extension-api: settings.tabs contribution gains optional `group` (additive public-API change, reviewed as one; default "Add-ons" for third-party); fallback = priority band appends under Add-ons.
- Fix the broken "Open Relay settings" empty-state deep link; Relay-off empty state tells the truth (env-var controlled) or gains a real toggle — Phase 3 decision.
- Mobile: drill-in single-pane nav renders group headers as list sections (verify Phase 3).

### D5 — Marketplace vocabulary stands, bridges made explicit

Package type ids + facet labels (Agents, Plugins, Skill Packs, Adapters+Connectors, Shapes) are marketplace-author domain: manifest contracts authors write (facet label diverging from manifest key would force translation). Bridge lines are region-matched, two not one: messaging-flavored adapters → "Adds a new way to reach your agents"; connector-refinement adapters → "Adds a new service your agents can act on". Install toast deep-links to the matching Connections region. Plugin⊃Extension explained where both appear.

### D6 — Two-layer naming, recorded

Wire formats, API paths, schema names, seam names unchanged. New ADR carries the product↔architecture mapping table + the scoped-word registry with P6's viewport test: {Relay, Mesh: subsystem brands — marketing/docs-concepts/architecture yes, cockpit chrome no ("Messaging is off", not "Relay is disabled"); adapter/connector: marketplace-author + architecture; provider: OpenCode model-provider + summoned plumbing; channel(platform): only platform-qualified; docs/concepts/relay.mdx gains a Connections cross-link since "telegram" searches land there}.

### D7 — MCP: one declared home per direction

Outbound MCP servers ("give my agents tools") land on the Connections page when that work is scheduled (fast-follow, not this pass). Inbound (DorkOS-as-MCP-server, Settings→Tools card) renamed for direction: "Connect other apps to DorkOS". Per-agent MCP list is a read-only runtime-owned overview (verified) and stays. The three surfaces cross-link now.

## The test (what users see after)

> **Addendum (2026-08-08, `specs/team-room-home`):** the "sidebar unchanged" claim below is
> superseded. The team-room-home program shrinks the sidebar to **Home · Team · Connections ·
> Marketplace** (+ Search): "Agents" became "Team" (shipped with `/team`, DOR-973), and
> Activity, Tasks (labeled "Scheduled"), and Workspaces become tabs of the home surface at
> their existing routes. Every other decision in this plan stands.

Sidebar: Dashboard, Activity, Agents, Tasks, Workspaces, Connections, Marketplace + Channels/DMs — every noun disjoint, including "agent" (fleet-only). Telegram→Connections›Messaging; Gmail→Connections›Accounts; #release-train→Channels; pick Codex→Settings→Runtimes; install→Marketplace. Settings: 10 tabs, 5 groups + footer Remote Access. Vocab gate script green: no user-facing integration/connector/adapter/provider/platform-channel/runtime-agent outside scoped domains.

## Rollout

- **Wave 0 — D0 copy** (independent, ships first; POMs in same PRs).
- **Wave 1 — plumbing + payment:** deep-link route escape hatch, settings-tab redirect map, palette retarget+aliases, tour retarget, network-sense Connection retirement (~8 files), vocab-gate script landed and green. No vocabulary flip visible yet.
- **Wave 2 — the flip (one release):** Connections page v2 (two regions, wizard embedded, relay dialog deleted+redirect, provider demotion, fresh-install states), Settings deletions + grouped nav + title, rename families (badge/accordion/inspector/dialogs), D1 residue sweep, D4 tool-inventory relabels, D5 bridge lines+toast, dashboard promo retarget, docs+site sweep with redirects, glossary, ADR, changelog fragments. Parallel worktrees per surface, one integration branch, adversarial review per PR + full-app review pass.
- **Wave 3 — flows:** designed dual-intent connect step; extension-api `group` if not landed; MCP cross-links; D7 fast-follow when scheduled.
- Hard constraint: browser tests run un-path-filtered on every PR and merge_group — every rename PR carries its e2e updates; large integration branches re-run the full suite per queue rebuild (keep PRs coherent, not huge).

## Residual risks (carried into the brief)

1. Two-region page unproven as a design; escape hatch = two tabs under one nav item; Phase 3 visual evidence decides.
2. Wave 2 size — largest coordinated change this repo has run; boundaries shown explicitly so reviewers can argue.
3. Accounts region on fresh install shows nothing connectable without a provider key (vendor catalog counsel-gated, DOR-750) — first impression needs a designed state, not prose.
4. Third rename, publicly — release note written as carefully as the UI: "Integrations is now part of Connections" + why it's the last one.
5. grep-zero gate must be a pinned script or it decays (assert-tests-executed.sh precedent).

## Open questions for Dorian

1. Confirm D2's word choice (Connections) given the honest cost: third rename of the relay surface in ~4 months, one accepted-8-days-ago ADR partially superseded.
2. Confirm killing the Settings→Integrations tab entirely (vs keeping a stub that links to the page).
3. Confirm Default agent moves to the Agents page (fleet menu) with no Settings row.
4. Docs split appetite: rename docs/integrations/ → docs/build/ now, or scope-note only.
5. Any appetite to promote Remote Access to a real settings panel later (out of scope here).

---

## Phase 3 design decisions (2026-08-03, visual-companion session with Dorian)

Session mockups: `.dork/visual-companion/70616-1785757745/content/` (gitignored; prose here is authoritative).

1. **Connections page structure: two regions, one scroll** (Messaging / Accounts), not tabs, not a unified badge grid. Region separation carries the two consent stories.
2. **Fresh-install Accounts: split honesty.** Direct-OAuth tiles (GitHub, Linear, Notion) lit and instantly usable; carrier-required tiles labeled truthfully with brand names — "Gmail — connects through Composio. One-time setup (~2 min). Your sign-ins live in Composio's vault, not on this machine." Never say "engine" or "provider" (both failed live comprehension test with the founder); the Advanced section is titled "Composio & Nango".
3. **Connection scoping model — three moves that compose:**
   - **Move 1 — connections belong to agents.** Persisted agent-level attachment for connector accounts (new store; today session-only+in-memory); sessions inherit automatically on start; session-level attach/detach stays as an override; precedence session > agent, no merging (Claude Code MCP ladder pattern). Messaging bindings are already agent-scoped — the UI starts saying so.
   - **Move 2 — agent-first flow, nothing silent.** Every connect flow knows its agent (implied from agent profile, or step 1 on the page). A messaging adapter cannot exist without a binding — created atomically in the wizard. One chat routes to one agent: uniqueness enforced at creation with an explicit "This chat reaches X. Move it to Y?" dialog (kills the silent creation-order shadowing found in the audit). Inbound from an unbound chat surfaces as a claim card ("Miguel messaged your bot — which agent should answer? / Ignore / Block") instead of today's silent drop; nothing is said in-chat until claimed (consent preserved, made visible). Shipped (DOR-856): the DM card offers all three actions — pick an agent and **Answer**, **Ignore**, or **Block**.
   - **Move 3 — chats-as-channels bridge (own program, spec'd immediately after the language waves).** A bound external chat projects into a channel: inbound → room post → room-turn (existing per-(room,agent) session continuity); outbound = any session posts to the room → bridge delivers to the platform; the room log is the single shared history. Seams verified present: telegram outbound `handleTypingSignal` comment, room-trigger/writer.post/late-delivery machinery. This answers the industry-wide unsolved many-sessions-one-chat problem with a primitive only DorkOS has.
4. **Sequencing: Option A** — Moves 1+2 ship alongside the language program; Move 3 is its own spec'd program executed next in the same autonomous run.
5. **Facts driving fixes** (from the 2026-08-03 audit): binding ties shadow silently by creation order; unbound inbound drops silently; `resolve()` doesn't filter `enabled`; outbound identity is cwd/agent-derived (canInitiate-gated); connector session attachments don't survive restart.
6. **Follow-ups to file in Linear:** (a) DorkOS-hosted Google OAuth app (Workspace MCP servers exist since 2026-05 but need a registered OAuth client; ADR amendment + counsel/CASA diligence, fold into DOR-750); (b) marketplace bridge-line copy (two region-matched lines per D5).
7. **Open questions from the brief — all resolved by Dorian's approval:** Connections umbrella confirmed; Settings→Integrations tab deleted entirely (no stub); Default agent to the Agents page only; docs/integrations gets a scope-note now (dir rename deferred); "Subagents" term kept.
8. **Stranger & group policy (Move 2/3, settled 2026-08-03):** Telegram bots are publicly discoverable, so: an unclaimed chat NEVER triggers an agent — no model run, no spend, no prompt-injection surface; the stranger's message renders as data on a cockpit claim card only, and the bot stays silent in-chat until claimed (quieter than Claude Code Channels' pairing-code pattern). Claim cards collapse per chat; Ignore mutes; Block drops future traffic cardlessly. A bot added to a group is a new group-kind chat → same claim flow. Shipped (DOR-856): the group card headline reads "Ana added your bot to 'X'" (the group title "X" comes from `chatTitle`, carried end to end from the platform sighting through the unclaimed-chat store to the card), asks "Which agent should join?", and offers **Join** / **Ignore** / **Block** (there is no "Leave" action — Block is the third choice for groups too). Telegram privacy mode stays default-ON (bot sees only @mentions/replies/commands), so a bridged channel's room log contains only what the bot legitimately received; the channel header states its visibility ("sees mentions only" vs "sees everything"), and turning privacy off remains Telegram's own deliberate re-add ritual. In bridged group channels the agent is mention-gated by default per agent-etiquette (over-participation is the failure mode).
