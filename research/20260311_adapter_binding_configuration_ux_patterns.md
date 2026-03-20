---
title: 'Adapter & Binding Configuration UX Patterns'
date: 2026-03-11
type: external-best-practices
status: active
tags: [adapter, binding, routing, multi-instance, progressive-disclosure, ux, configuration]
feature_slug: adapter-agent-routing
searches_performed: 12
sources_count: 35
---

# Adapter & Binding Configuration UX Patterns

**Date**: 2026-03-11
**Research Depth**: Deep Research
**Searches performed**: 12

---

## Research Summary

Multi-instance adapter management, routing/binding configuration, and progressive disclosure in setup wizards are well-solved problems across automation platforms (Zapier, n8n, Make.com, IFTTT), messaging tools (Slack, Discord, Intercom, Zendesk), and developer infrastructure (Stripe, GitHub). The research synthesizes patterns from these products into five recommendations for DorkOS's adapter/binding system. The strongest patterns are: (1) auto-generated connection labels with user-customizable names (Zapier model), (2) visual workflow-based routing with catch-all fallbacks (Intercom/Zendesk model), (3) inline status banners for incomplete setup rather than blocking modals (Home Assistant/Stripe model), (4) live-data pickers populated from adapter state for chat/channel selection, and (5) contextual sidebar filtering scoped to the currently selected entity (Linear model).

---

## Key Findings

### 1. Multi-Instance Adapter Patterns

**Finding**: Every major automation platform supports multiple connections to the same service, and they all converge on the same three-layer UX: auto-generated label, user-customizable name, and a dropdown selector when multiple instances exist.

#### Zapier: The Gold Standard for Connection Labeling

Zapier's connection label system is the most refined in the industry:

- **Auto-generated default**: First connection = "Gmail". Second = "Gmail #2". Third = "Gmail #3". Simple numbering. - [App connections on Zapier](https://help.zapier.com/hc/en-us/articles/36818633398157-App-connections-on-Zapier)
- **Smart labeling from API data**: Integration builders can template labels using data from the authentication test response: `{{username}}` or `{{bundle.inputData.details.name}}`. This means a Telegram bot connection could auto-label as "Telegram (my-project-bot)" by pulling the bot username from the Telegram API response. - [Add a connection label](https://docs.zapier.com/platform/build/connection-label)
- **User-customizable**: Users can rename connections from the connection management page. The Zapier community explicitly recommends this as a best practice: "Label App Connections when there are Multiple Accounts for 1 App." - [BEST PRACTICE: Label App Connections](https://community.zapier.com/tips-and-inspiration-5/best-practice-label-app-connections-when-there-are-multiple-accounts-for-1-app-13922)
- **Dropdown selection**: When creating a Zap step, if multiple connections exist for the same app, a dropdown shows all connections with their labels. The user picks which one to use.

#### Make.com: Connection Naming Conventions

Make.com takes a more structured approach to naming:

- **Naming convention**: Recommended format includes service name, environment (production/sandbox), and owner: e.g., "Gmail - Production - Marketing Team". - [Connections guide for Make.com](https://consultevo.com/connections-guide-make-com/)
- **Reuse across scenarios**: One connection can be reused in multiple scenarios, avoiding repeated authentication. This is a key efficiency win.
- **Dynamic connections (Enterprise)**: For advanced multi-tenant use cases, connections can be selected dynamically at runtime based on variables. This is overkill for DorkOS but instructive — it shows where the pattern scales. - [Dynamic connections](https://help.make.com/dynamic-connections)

#### IFTTT: Primary Account Pattern

IFTTT's multi-account model (Pro+ only) introduces a useful concept:

- **Primary account designation**: The first connected account becomes "primary" and is the default for new Applets. Additional accounts must be explicitly selected. - [What is the multiple accounts per service feature?](https://help.ifttt.com/hc/en-us/articles/4410092769307-What-is-the-multiple-accounts-per-service-feature)
- **Per-Applet account selection**: When creating an Applet, users choose which account to use from a list. You can even use different accounts for trigger and action within the same Applet.
- **Management centralized**: All connected accounts are managed from the service's settings page, not scattered across individual Applets.

#### n8n: Credential Library

n8n treats connections as "credentials" with a dedicated library:

- **Credential naming**: Users give each credential a custom name at creation time. No auto-generation — the user must name it. This can cause confusion when users forget which credential is which. - [Credentials library](https://docs.n8n.io/credentials/)
- **Per-node selection**: Each workflow node has a credential dropdown. Multiple credentials of the same type are supported but the UX has rough edges — users have reported confusion when OAuth reconnects create duplicate credentials. - [Prompt to reuse existing credential](https://community.n8n.io/t/prompt-to-reuse-existing-credential-when-connecting-identical-oauth-account/216653)
- **Test button**: Each credential has a "Test" action to verify it works before using it in a workflow.

#### Recommendation for DorkOS

**Adopt the Zapier model with simplification:**

1. **Auto-label from adapter API**: When a Telegram bot token is added, immediately call `getMe()` and auto-label as "Telegram (@bot_username)". For webhooks, label as "Webhook (endpoint-slug)".
2. **User-customizable label**: The `label` field on `AdapterConfig` (already exists) should be prominently editable in the adapter card. Default to the auto-generated label.
3. **Numbering fallback**: If auto-labeling fails (API unreachable), fall back to "Telegram #1", "Telegram #2" pattern.
4. **"Add another" flow**: On the adapter catalog card, show a badge with instance count (e.g., "2 connected"). A "+" button or "Add another" link opens the setup wizard pre-filled with the adapter type.
5. **Visual differentiation**: Multiple instances of the same adapter type should show the custom label prominently and the adapter type as a secondary label. Use the platform icon consistently but vary the text.

```
Adapter card (multi-instance):
┌──────────────────────────────────┐
│  [Telegram icon]                 │
│  @project-bot                    │  ← custom label (from API)
│  Telegram Bot                    │  ← adapter type (secondary)
│  ● Connected · 42 msgs today    │
│  [Configure]  [+ Add Another]   │
└──────────────────────────────────┘
```

---

### 2. Routing/Binding Configuration UX

**Finding**: The industry has settled on three tiers of routing complexity, and DorkOS should implement the simplest tier (explicit bindings) with an escape hatch to the second tier (rule-based routing) only when needed.

#### Tier 1: Explicit Bindings (Intercom, Zendesk, Discord)

The most common pattern for "message comes in, route to team/agent":

**Intercom Workflows**: Visual canvas-based routing. Conversations enter via a channel (Web Messenger, email, SMS, social). A workflow evaluates conditions (user attributes, message content) and routes to a team inbox. The default workflow is a simple "route all to General team." - [Route customer conversations to the right team](https://www.intercom.com/help/en/articles/9630589-route-customer-conversations-to-the-right-team)

**Zendesk Omnichannel Routing**: Conversations from all channels (messaging, email, chat, voice) enter a unified routing queue. Assignment is based on agent availability, capacity, skills, and priority. The key UX: a single configuration page where you set channel-level routing rules, not per-conversation rules. - [Managing your omnichannel routing configuration](https://support.zendesk.com/hc/en-us/articles/4828787357210-Managing-your-omnichannel-routing-configuration)

**Discord Channel Permissions**: Bots are restricted to specific channels via role-based permissions. Admins configure which channels a bot can read/write in the server settings. The UX: a channel picker in the bot's integration settings page. - [Restrict bots to certain channels](https://support.discord.com/hc/en-us/community/posts/360045778711-Restrict-bots-to-certain-channels)

#### Tier 2: Rule-Based Routing (Gmail Filters, Outlook Rules)

**Gmail Filters**: "If [from/to/subject/contains] matches X, then [label/archive/forward/delete]." The UX is a simple form with condition fields and action checkboxes. Rules are evaluated top-to-bottom; first match wins. - [Create rules to filter your emails](https://support.google.com/mail/answer/6579?hl=en)

**Key Gmail UX patterns**:

- Create filter from search: users can right-click a message and "Filter messages like this" — pre-populating the condition from the message's attributes
- Condition fields are AND-combined (all must match)
- Actions are multi-select checkboxes (multiple actions per rule)
- "Also apply filter to matching conversations" handles retroactive application

**Google Workspace Admin Routing**: More powerful than Gmail filters. Rules specify: messages to affect (inbound/outbound/internal), conditions (header matches, envelope match, account type), and actions (modify headers, change route, reject). Rules processed top-to-bottom. - [Add Gmail Routing settings](https://support.google.com/a/answer/6297084?hl=en)

#### Tier 3: Visual Workflow Routing (n8n, Make.com)

Full workflow canvases with branching logic, conditions, and multiple actions. Overkill for DorkOS's binding use case (already covered in existing research at `20260228_adapter_agent_routing.md`).

#### The "Catch-All" vs "Specific" Pattern

Every routing system handles the default/fallback case:

- **Intercom**: Default workflow catches everything not matched by custom workflows
- **Zendesk**: "Default group" receives unrouted tickets
- **Gmail**: Unfiltered mail goes to inbox (the implicit catch-all)
- **Discord**: Bots with server-wide permissions can read all channels unless specifically denied

**The universal pattern**: Specific rules are evaluated first (most-specific wins). If nothing matches, the catch-all/default receives the message. The catch-all should always exist and be clearly visible in the UI.

#### Recommendation for DorkOS

**Implement binding-table routing (already decided in prior research) with these UX refinements:**

1. **Default binding**: Every adapter should have an implicit "catch-all" binding that can be configured. When an adapter has no bindings, show an empty state: "No agent assigned — messages will go to dead letter."
2. **Binding creation UX**: Two paths:
   - **From adapter card**: "Bind to agent" dropdown shows all registered agents. One click creates a catch-all binding.
   - **From topology view**: Drag adapter to agent (already designed in prior research).
3. **Specific bindings** (chat-level): Show a "Refine" option on existing bindings. Clicking opens a panel where the user can narrow the binding to specific chat IDs. Use the Gmail "filter from message" pattern — let users create specific bindings from the message log: "Route messages from this chat to [agent picker]."
4. **Visual priority**: In the binding list, show specific bindings above the catch-all, with clear visual hierarchy (specific = full opacity, catch-all = muted/labeled "Default").

```
Binding List UI:
┌──────────────────────────────────────────────┐
│  @project-bot → Builder Agent                │
│  ──────────────────────────                  │
│  Chat "Design Review" → Architect Agent      │  ← specific (bold)
│  Chat "Deploy Alerts" → DevOps Agent         │  ← specific (bold)
│  All other chats → Builder Agent (default)   │  ← catch-all (muted)
│                                              │
│  [+ Add Rule]                                │
└──────────────────────────────────────────────┘
```

---

### 3. Progressive Disclosure in Setup Wizards

**Finding**: The best multi-step setup flows share five characteristics: (1) minimal initial surface, (2) inline completion status, (3) non-blocking "you're not done yet" indicators, (4) re-entrant at any step, and (5) the first step always delivers immediate visible value.

#### Stripe: The Benchmark for Developer Onboarding

Stripe's onboarding is widely cited as best-in-class:

- **Immediate value**: After API key creation (step 1), you can make a test API call immediately. You don't need to complete all onboarding steps to start using the product.
- **Checklist as progress tracker**: The dashboard shows a persistent checklist of setup steps. Completed steps are checked. Incomplete steps show what's needed. The checklist is always visible but never blocking.
- **Progressive information**: Each step reveals only the information needed for that step. Business verification doesn't show payment configuration fields. KYC doesn't show webhook setup.

#### Slack App/Bot Setup: Channel-by-Channel Disclosure

Slack's bot setup flow demonstrates progressive disclosure for permissions:

- **Step 1**: Create app (name + workspace). Immediate result: you have an app.
- **Step 2**: Add bot user (toggle). Now your app can appear in conversations.
- **Step 3**: Subscribe to events (checkboxes). Only the events you need.
- **Step 4**: Install to workspace (OAuth). The bot appears in Slack.
- **Post-install configuration**: Channel permissions, slash commands, and interactive components are configured after the bot is live — not before. This is critical: the bot works with defaults, and customization is optional.

#### GitHub App Installation: Post-Install Redirect

GitHub's App installation flow uses a "setup URL" pattern:

- **During install**: User authorizes the app, selects repositories. Minimal friction.
- **Post-install redirect**: The app can specify a URL to redirect users to after installation. This is where configuration happens — repository-specific settings, webhook configuration, etc. - [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- **Challenge**: State management between GitHub's OAuth flow and the app's configuration flow is notoriously difficult. Many developers report that the `state` parameter doesn't survive the redirect properly.

#### Home Assistant: Config Flow Wizard Pattern

Home Assistant's integration setup flow is the most directly comparable to DorkOS's adapter setup:

- **Multi-step config flow**: Each integration defines steps (`async_step_user`, `async_step_reauth`). Each step shows a form. Validation errors return to the same step.
- **Abort conditions**: If setup fails (bad credentials, unreachable device), the flow aborts with a clear error message. The user can retry.
- **Incomplete setup indicators**: Integrations that are configured but have issues show warning badges on the Integrations page. This is the "you're not done yet" pattern — a persistent, non-blocking visual indicator.
- **Reconfiguration**: Users can reconfigure integrations without removing them. The wizard reopens with existing values pre-filled (except secrets, which show "leave blank to keep current").

#### "You're Not Done Yet" Without Being Annoying

The research reveals a clear hierarchy of notification patterns for incomplete setup:

1. **Best: Inline status indicator** — A subtle badge/dot on the adapter card: "Needs binding" or "No agent assigned." Always visible, never interrupts. (Home Assistant, Stripe checklist model)
2. **Good: Contextual banner** — When the user views the adapter detail, show a banner: "This adapter is receiving messages but no agent is bound. Messages will go to dead letter." Dismissible but reappears if the condition persists.
3. **Acceptable: One-time toast** — After adapter creation, show a toast: "Adapter connected. Bind it to an agent to start receiving messages." Shows once, doesn't repeat.
4. **Bad: Modal/blocking dialog** — "You must complete setup!" Breaks flow, especially for expert users who may intentionally want an unbound adapter.

#### Recommendation for DorkOS

**Adopt the Stripe checklist + Home Assistant config flow hybrid:**

1. **Adapter creation wizard**: 3 steps maximum:
   - Step 1: Select type (catalog card click)
   - Step 2: Configure credentials (form from ConfigField[])
   - Step 3: Test connection (auto-runs, shows success/failure)
   - The wizard closes here. Binding is NOT part of the wizard.

2. **Post-creation nudge**: After the wizard closes, the adapter card shows an inline status:
   - `Connected - No agent bound` (amber dot)
   - A subtle "Bind to agent" link appears on the card
   - If the user clicks elsewhere, the status persists but doesn't block

3. **Re-entrant**: Clicking "Configure" on any adapter reopens the wizard at Step 2 with current values pre-filled. Secrets show "leave blank to keep current" placeholder.

4. **The Apple principle**: The adapter works (receives messages, stores them) even without a binding. Messages go to dead letter where the user can see them. This means Step 3 (test connection) delivers real value — the adapter is functional. Binding is an optimization, not a prerequisite.

---

### 4. Chat/Channel Selection UX

**Finding**: The best chat selection UIs use live-data pickers populated from adapter state, not manual text input for chat IDs.

#### Intercom: Team-Based Channel Assignment

Intercom's model assigns conversations to team inboxes:

- **Team inboxes**: Pre-defined teams (Sales, Support, Engineering). Each has its own inbox.
- **Workflow routing**: Visual workflows route conversations to teams based on conditions (user attributes, page URL, message content).
- **Assignment methods**: Balanced (least busy agent) or round-robin (sequential). - [Workload management explained](https://www.intercom.com/help/en/articles/6560715-automatically-route-conversations-to-teammates)
- **No manual chat picker**: Intercom routes automatically. Users don't manually assign chats to teams — the workflow does it.

#### Zendesk: Skills-Based Routing

Zendesk's omnichannel routing uses agent skills as the routing mechanism:

- **Skills**: Agents have tagged skills (language, product area, tier). Tickets are routed to agents with matching skills.
- **Groups**: Agents belong to groups. Routing rules can target groups.
- **Priority override**: High-priority tickets jump the queue regardless of routing rules.
- **The picker**: Administrators configure routing rules in a form-based UI. They select groups, set skill requirements, and define priority thresholds. There's no "pick a specific chat" UI — routing is rule-based, not manual.

#### HubSpot Chatbot: If/Then Routing

HubSpot's chatbot builder uses a visual branching model:

- **Qualifying questions**: Bot asks questions, branches based on answers.
- **Route to team member**: A "Connect to Team Member" action hands off to a live agent. The agent is selected based on availability or specific assignment.
- **Channel selection**: When creating a chatflow, the user selects which website pages or messaging channels the bot appears on. This is a simple checkbox list.

#### The "Live Data Picker" Pattern

For DorkOS's use case (binding specific Telegram chats to specific agents), the ideal UX:

1. **Adapter receives messages** → chats appear in the adapter's message log
2. **User views message log** → sees chats listed with their IDs and display names
3. **User clicks "Route this chat"** → agent picker appears
4. **Binding is created** from the live data (chat ID auto-populated)

This is the Gmail "filter messages like this" pattern applied to chat routing. The user never types a chat ID manually — they pick from observed data.

#### Recommendation for DorkOS

**Implement a "Route from message" flow:**

1. **Message log shows chat groups**: In the InboxView/ConversationRow, show a "Route" button or right-click menu.
2. **Agent picker popover**: Shows registered agents with their names and working directories. One click creates a specific binding for that chat ID → agent.
3. **Binding management**: The binding list (in adapter detail or topology view) shows all bindings with chat names resolved from message metadata.
4. **Fallback for unknown chats**: Until a chat has sent a message, it can't appear in the picker. This is fine — the catch-all binding handles unknown chats. Specific bindings are created reactively, not proactively.

```
Message Log UX:
┌──────────────────────────────────────────────┐
│  Telegram @project-bot                       │
│  ──────────────────────────                  │
│  [avatar] Design Review (chat:12345)         │
│  "Can you review the new header?"            │
│  2m ago                    [Route to Agent ▾] │
│                                              │
│  [avatar] Deploy Alerts (chat:67890)         │
│  "Build succeeded on main"                   │
│  5m ago                    [Route to Agent ▾] │
└──────────────────────────────────────────────┘

Agent Picker Dropdown:
┌───────────────────────┐
│ Builder Agent         │
│ ~/projects/website    │
├───────────────────────┤
│ DevOps Agent          │
│ ~/projects/infra      │
├───────────────────────┤
│ Architect Agent       │
│ ~/projects/platform   │
└───────────────────────┘
```

---

### 5. Sidebar Connection Filtering

**Finding**: The best sidebar filtering patterns scope their content to the currently selected context, use sticky filter summaries, and provide progressive expandability.

#### Linear: Contextual Sidebar with View Filtering

Linear's right-hand sidebar is the strongest reference for DorkOS:

- **Context-aware content**: When viewing a project, the sidebar shows project-relevant information: leads, teams, members, health status. When viewing an issue, the sidebar shows assignees, labels, linked projects.
- **Quick filters**: The sidebar provides fast-access filters for common properties within the current view. - [Custom Views](https://linear.app/docs/custom-views)
- **Custom views**: Users create saved filter combinations. These appear as nav items in the left sidebar. The pattern is: configure filters once, save as a named view, access instantly thereafter.

#### Enterprise Filtering Best Practices

From UX research on enterprise filtering patterns: - [Filter UX Design Patterns & Best Practices](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-filtering)

- **Sidebar positioning**: Left-hand sidebars offer the most scalability for complex filter sets. Expandable sections keep the initial view clean.
- **Priority by usage**: Order filters by how frequently they're used, not alphabetically. For DorkOS: adapter type and agent assignment are the top filters; chat ID and message content are secondary.
- **Filter chips**: Applied filters display as removable chips/pills at the top of the content area. Numeric badges show how many values are selected (e.g., "Adapter (2)").
- **Search within filters**: For large datasets, provide search within the filter panel itself. Not needed for DorkOS's initial scale (< 20 adapters, < 20 agents) but worth planning for.

#### Figma: Collaborator Filtering Per File

Figma's approach to showing relevant collaborators:

- **Per-file scope**: When editing a file, only collaborators who have access to that file appear in the presence indicators and sharing panel.
- **Team-level vs file-level**: The broader team list is available in team settings, but the file-level view shows only the relevant subset.
- **Real-time presence**: Active collaborators are shown with live cursors. Inactive collaborators are listed but visually muted.

#### Recommendation for DorkOS

**Implement contextual filtering in the RelayPanel sidebar:**

1. **When an agent is selected in the Mesh panel**: The RelayPanel should filter to show only adapters/bindings connected to that agent. This answers "what channels is this agent listening on?"

2. **When an adapter is selected**: Show only bindings for that adapter and the agents they route to. This answers "where do this adapter's messages go?"

3. **Filter chips in the panel header**: Show active filters as removable chips: `[Agent: Builder] [Status: Connected]`. Clearing all chips shows the full view.

4. **Sticky applied filter summary**: At the top of the binding list, show "Showing 3 of 12 bindings for Builder Agent" so the user always knows the view is filtered.

5. **"Show all" escape hatch**: A clear link to remove filtering and see the complete picture. This respects expert users who want the full topology view.

```
RelayPanel with contextual filter:
┌──────────────────────────────────────────────┐
│  Relay                                       │
│  [Agent: Builder ✕] [Connected ✕]  Show all  │
│  ──────────────────────────                  │
│  Showing 2 of 5 adapters                     │
│                                              │
│  ┌────────────────────────────────────┐      │
│  │ @project-bot (Telegram)            │      │
│  │ ● Connected · Bound to Builder     │      │
│  └────────────────────────────────────┘      │
│                                              │
│  ┌────────────────────────────────────┐      │
│  │ deploy-hooks (Webhook)             │      │
│  │ ● Connected · Bound to Builder     │      │
│  └────────────────────────────────────┘      │
└──────────────────────────────────────────────┘
```

---

## Detailed Analysis

### Cross-Cutting Theme: The Separation of Connection and Configuration

Across every platform studied, there's a clear separation between "connecting" (authentication/credentials) and "configuring" (routing/behavior). This maps directly to DorkOS's adapter (connection) and binding (configuration) model:

| Platform       | Connection Concept            | Configuration Concept      |
| -------------- | ----------------------------- | -------------------------- |
| Zapier         | Connection (OAuth/API key)    | Zap step configuration     |
| n8n            | Credential                    | Workflow node settings     |
| Make.com       | Connection                    | Scenario module settings   |
| Intercom       | Channel (Messenger/email/SMS) | Workflow routing rules     |
| Zendesk        | Channel                       | Omnichannel routing config |
| Discord        | Bot (token + permissions)     | Channel permissions        |
| Home Assistant | Integration                   | Automation/entity config   |

DorkOS's existing adapter/binding split is architecturally correct and aligns with industry patterns. The key UX insight: never force users to do both in a single flow. Connect first, configure second. Each can be done independently and at different times.

### The "Wiring Board" Metaphor vs "Rules List" Metaphor

Two competing visual metaphors exist for routing configuration:

**Wiring Board** (React Flow canvas, already designed in prior research):

- Pros: Immediate visual understanding of the full topology. Drag-to-connect is intuitive. Shows the complete picture at a glance.
- Cons: Doesn't scale well beyond ~20 nodes. Harder to express conditional routing. Mobile/small-screen challenges.
- Best for: DorkOS's primary use case (1:1 adapter-to-agent bindings with small topology).

**Rules List** (Gmail filters, Zendesk routing rules):

- Pros: Scales to hundreds of rules. Easy to express conditions. Familiar to developers. Sortable/searchable.
- Cons: No visual overview of the topology. Harder to spot gaps in routing. Less "delightful."
- Best for: Complex conditional routing with many rules.

**Recommendation**: Use the wiring board as the primary view (it aligns with the DorkOS "control panel" aesthetic), but provide a "Binding List" view as a secondary tab for power users who want to see and manage all bindings in a table format. The table view is also the better mobile fallback.

### Progressive Disclosure Hierarchy for DorkOS Adapter Setup

Applying the Jony Ive principle ("True simplicity is derived from so much more than just the absence of clutter"):

**Level 0 — Zero State**: Empty Relay panel. Single call to action: "Add your first adapter." No mention of bindings, routing, dead letters, or topology.

**Level 1 — First Adapter**: After adding an adapter, the UI shows: adapter card with connection status + "Bind to agent" prompt. The binding concept is introduced here, but only the simplest version (pick one agent from a list).

**Level 2 — First Binding**: After binding, the UI shows: adapter card connected to agent in a simple visual. Messages start flowing. The message log becomes visible. Dead letter section appears only if unrouted messages exist.

**Level 3 — Multi-Instance**: After adding a second adapter or second binding, the topology view becomes available. The "Add another" flow appears on existing adapter cards. The binding list view becomes useful.

**Level 4 — Specific Routing**: After seeing messages from multiple chats, the "Route this chat" action appears on conversation rows. Specific bindings (chat-level) become available. Catch-all vs specific is now a meaningful distinction.

**Level 5 — Advanced**: Rate limiting per binding, session strategy selection, audit log. These live in a binding detail panel, accessed by clicking a binding edge or row.

Each level is only revealed when the user's setup has grown complex enough to need it. A single adapter with a single binding never sees Level 3-5 complexity.

---

## Sources & Evidence

### Multi-Instance Adapter Patterns

- [App connections on Zapier](https://help.zapier.com/hc/en-us/articles/36818633398157-App-connections-on-Zapier) — Auto-numbering of multiple connections
- [Add a connection label - Zapier](https://docs.zapier.com/platform/build/connection-label) — Template-based connection labels from API data
- [BEST PRACTICE: Label App Connections](https://community.zapier.com/tips-and-inspiration-5/best-practice-label-app-connections-when-there-are-multiple-accounts-for-1-app-13922) — Community best practices for connection naming
- [Manage your app connections](https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections) — Connection management UI
- [Credentials library - n8n](https://docs.n8n.io/credentials/) — n8n credential management
- [Connections guide for Make.com](https://consultevo.com/connections-guide-make-com/) — Make.com connection naming conventions
- [Dynamic connections - Make.com](https://help.make.com/dynamic-connections) — Dynamic connection selection at runtime
- [What is the multiple accounts per service feature? - IFTTT](https://help.ifttt.com/hc/en-us/articles/4410092769307-What-is-the-multiple-accounts-per-service-feature) — IFTTT multi-account pattern
- [Can I connect more than one account to a service? - IFTTT](https://help.ifttt.com/hc/en-us/articles/115010396468-Can-I-connect-more-than-one-account-to-a-service) — IFTTT per-Applet account selection

### Routing/Binding Configuration

- [Route customer conversations to the right team - Intercom](https://www.intercom.com/help/en/articles/9630589-route-customer-conversations-to-the-right-team) — Workflow-based conversation routing
- [Workload management explained - Intercom](https://www.intercom.com/help/en/articles/6560715-automatically-route-conversations-to-teammates) — Balanced assignment and round-robin
- [Managing your omnichannel routing configuration - Zendesk](https://support.zendesk.com/hc/en-us/articles/4828787357210-Managing-your-omnichannel-routing-configuration) — Omnichannel routing configuration
- [About omnichannel routing - Zendesk](https://support.zendesk.com/hc/en-us/articles/4409149119514-About-omnichannel-routing) — Skills and group-based routing
- [Create rules to filter your emails - Gmail](https://support.google.com/mail/answer/6579?hl=en) — Gmail filter creation UX
- [Add Gmail Routing settings - Google Workspace](https://support.google.com/a/answer/6297084?hl=en) — Admin-level routing rules
- [Restrict bots to certain channels - Discord](https://support.discord.com/hc/en-us/community/posts/360045778711-Restrict-bots-to-certain-channels) — Discord bot channel restriction
- [Create a rule-based chatbot - HubSpot](https://knowledge.hubspot.com/chatflows/create-a-bot) — HubSpot chatbot If/Then routing

### Progressive Disclosure

- [Progressive Disclosure - NN/g](https://www.nngroup.com/articles/progressive-disclosure/) — Nielsen Norman Group foundational article
- [Disclosure controls - Apple HIG](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls) — Apple's disclosure control guidelines
- [The craft of SwiftUI API design: Progressive disclosure - WWDC22](https://developer.apple.com/videos/play/wwdc2022/10059/) — Apple's philosophy on progressive disclosure in APIs
- [Progressive Disclosure Examples - Userpilot](https://userpilot.com/blog/progressive-disclosure-examples/) — SaaS progressive disclosure examples
- [The Power of Progressive Disclosure in SaaS UX Design](https://lollypop.design/blog/2025/may/progressive-disclosure/) — Progressive disclosure in SaaS
- [Design Guidelines For Better Notifications UX - Smashing Magazine](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/) — Notification design for incomplete setup
- [Onboarding - Stripe Documentation](https://docs.stripe.com/stripe-apps/onboarding) — Stripe app onboarding flow
- [Modifying a GitHub App registration - GitHub Docs](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration) — GitHub App post-install setup URL

### Sidebar Filtering

- [Filter UX Design Patterns & Best Practices - Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-filtering) — Enterprise filtering patterns
- [Custom Views - Linear Docs](https://linear.app/docs/custom-views) — Linear contextual views and saved filters

### Existing DorkOS Research (Incorporated)

- `research/20260228_adapter_agent_routing.md` — Binding table architecture, React Flow topology, session mapping
- `research/20260227_adapter_catalog_patterns.md` — ConfigField descriptors, AdapterManifest, setup wizard
- `research/20260301_ftue_best_practices_deep_dive.md` — Progressive disclosure philosophy, FTUE frameworks

---

## Research Gaps & Limitations

- **Drift chatbot** documentation was not accessible — Drift has been acquired by Salesloft and documentation may have moved. The Zendesk and Intercom patterns are sufficient substitutes.
- **Slack Workflow Builder** (the newer 2025 visual workflow tool) was not deeply analyzed. It may offer additional patterns for routing configuration UX.
- **Mobile/responsive behavior** of wiring board UIs was not researched. React Flow on small screens may need a fallback to list view.
- **Accessibility** of drag-to-connect interactions in React Flow was not evaluated. Keyboard-only users may need an alternative binding creation flow (the "Bind to agent" dropdown serves this purpose).
- **Real-time binding updates** (when a new chat appears, does the binding picker auto-update?) — needs implementation planning, not just UX research.

## Contradictions & Disputes

- **Zapier auto-labels vs n8n manual naming**: Zapier auto-generates labels from API data; n8n requires manual naming. Both are valid. The auto-label approach is better for DorkOS because it reduces friction and follows the Apple principle of "the computer should do the work." Manual override is available for users who want it.
- **Wiring board vs rules list**: These are not contradictory — they serve different scales. DorkOS should implement both, with the wiring board as primary (delight for small topologies) and the rules list as secondary (utility for complex setups).
- **Blocking vs non-blocking post-setup nudges**: Some patterns (product tours, modal wizards) push users through a complete flow. Others (inline status, banners) let users proceed at their own pace. For DorkOS's expert persona (Kai), non-blocking is the clear winner. Kai does not want to be told what to do next — he wants to see what needs doing and decide for himself.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "Zapier connection label multiple accounts", "Intercom routing conversations team", "progressive disclosure setup wizard", "enterprise filtering UX patterns sidebar"
- Primary information sources: Zapier help docs, Intercom help docs, Zendesk help docs, IFTTT help center, Pencil & Paper UX patterns, NN/g, Apple HIG
- Existing DorkOS research was heavily leveraged (3 prior reports covered architecture and catalog patterns)
