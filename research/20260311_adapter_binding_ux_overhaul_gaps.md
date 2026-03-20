---
title: 'Adapter/Binding UX Overhaul — Gap Research (Post-Setup, Live Pickers, Duplication, Status Indicators)'
date: 2026-03-11
type: external-best-practices
status: active
tags:
  [
    adapter,
    binding,
    post-setup,
    incomplete-configuration,
    status-indicator,
    live-picker,
    duplication,
    clone,
    routing,
    ux,
  ]
feature_slug: adapter-agent-routing
searches_performed: 22
sources_count: 42
---

# Adapter/Binding UX Overhaul — Gap Research

**Companion to**: `research/20260311_adapter_binding_configuration_ux_patterns.md`
**Date**: 2026-03-11
**Research Depth**: Deep Research
**Focus**: Four topics NOT covered in the prior report — post-setup nudges, live data pickers for routing, duplication patterns, and connection status indicators.

---

## Research Summary

This report fills four gaps left by the prior adapter/binding UX research. The core findings: (1) the strongest "incomplete configuration" pattern for developer tools is Stripe's progressive restriction model combined with Datadog's three-tier integration status badge — neither blocking nor silent; (2) Discord's auto-populated `channel_select` and Slack's `external_select` are the two canonical live-data picker patterns, with the "default to current context" trick from Slack conversations being especially valuable for DorkOS; (3) Zapier's `"Copy of [name]"` pattern for full duplication and `"Copy"` prefix for step duplication is the simplest defensible convention — connections are preserved but unique-resource fields (webhook URLs) are reset; (4) Carbon Design System's five-state status model (success / caution / warning / critical / informational) is the best design-system reference for encoding adapter + binding health in a single badge.

---

## Key Findings

### 1. Post-Setup "Incomplete Configuration" Patterns

**Finding**: The best developer tools use a three-tier escalation model for communicating incomplete setup — persistent inline badge, contextual banner on detail view, one-time post-action toast. They never block the user. The worst pattern is a modal that demands completion before the user can proceed.

#### Stripe: Progressive Restriction Without Blocking

Stripe's connected-account model is the most direct analogue to DorkOS adapters. An account can be "connected" (authenticated) but have outstanding requirements that, if unresolved, will eventually restrict its capabilities.

**State taxonomy**: Stripe uses four account states visible in the dashboard:

- **Enabled** — all capabilities active, no outstanding requirements
- **Restricted soon** — requirements are due; capabilities will pause at a future date
- **Restricted** — at least one capability is inactive due to unmet requirements
- **In review / Rejected** — Stripe is evaluating or has rejected the account

**Key UX pattern**: The dashboard shows a non-blocking "Actions required" section at the top of the account detail page, listing each outstanding requirement with clear instructions. The account continues to function (partially) while requirements are pending. No modals, no blocking. — [Review and take action on connected accounts](https://docs.stripe.com/connect/dashboard/review-actionable-accounts)

**The "Restricted soon" tab** is particularly instructive: it communicates future consequences without immediate disruption. DorkOS equivalent: an adapter that is "connected but unbound" should not block any existing workflow — it should just clearly communicate what will happen to unrouted messages (they go to dead letter).

#### Datadog: Three-Tier Integration Status

Datadog's integration tiles use a three-tier status that maps cleanly onto DorkOS's adapter + binding states:

- **Available** — integration exists in catalog, not installed
- **Detected** — technology is running, integration is not installed or not configured; only partial data is collected. (The key insight: the system _knows_ the thing exists but it's not configured yet.)
- **Installed** — integration is installed and fully configured; full data flowing

**Visual encoding**: An integration configured incorrectly appears yellow. Missing data after 24 hours shows a "Missing Data" badge. Full green = healthy. — [Introduction to Integrations — Datadog](https://docs.datadoghq.com/getting_started/integrations/)

**Applied to DorkOS**: An adapter that is connected but has no binding = "Detected." An adapter with a binding and active message flow = "Installed." An adapter with a failing connection = "Error."

#### Home Assistant: "Needs Attention" as a First-Class State

Home Assistant integrations can be in several states that are surfaced on the Integrations page:

- **Configured** — running normally
- **Failed setup, will retry** — connection error; system will auto-retry
- **Needs attention** — requires user action (reconfiguration, re-auth, missing device)
- **Attention required** — shown with a red badge; integration cannot function until resolved

**Critical UX pattern**: The "Needs attention" state is displayed inline on the integration card, never as a blocking modal. Clicking the card opens the reconfiguration flow. The user can dismiss the prompt and address it later — but the badge persists until the issue is resolved. — [Home Assistant "Needs Attention" pattern](https://github.com/home-assistant/core/issues/116566)

**This is the exact pattern DorkOS needs**: adapter cards should show a persistent amber/yellow badge when connected but unbound. The badge does not block anything. It disappears automatically when a binding is created.

#### Make.com: Warning Sign on Unconfigured Module

In Make.com's scenario canvas, a module that is added but not fully configured shows a warning sign (exclamation mark) on the node. Clicking the warning sign opens the configuration panel. The scenario cannot be activated until all modules are configured, but the user can save the draft and return. — [Introduction to errors and warnings in Make](https://www.make.com/en/help/errors/introduction-to-errors-and-warnings-in-make)

**DorkOS relevance**: This is the "canvas-level" version of the same pattern. For the topology view (React Flow), unconfigured adapter nodes could show an amber exclamation badge on the node itself.

#### Hookdeck: Paused Connection as Disconnected Yellow Line

Hookdeck's connection model (Source → Connection → Destination) is architecturally almost identical to DorkOS's (Adapter → Binding → Agent). In Hookdeck's UI:

- Active connections = normal solid line between source and destination
- Paused connections = **disconnected yellow lines** on the canvas

This is a powerful visual metaphor for DorkOS's topology view: an adapter with no binding could show a "dangling wire" — the adapter node exists but has no connected edge to any agent node. — [Connections — Hookdeck](https://hookdeck.com/docs/connections)

#### Sentry: "Waiting for First Event" Empty State

Sentry's new project setup shows a persistent "Waiting for first event" state that combines:

1. A prominent code snippet showing exactly what to add
2. A live indicator that updates when the first event arrives
3. No blocking — users can navigate away; the empty state persists in the background

**Applied to DorkOS**: After creating an adapter, show "Waiting for first message" in the message log. This communicates that the adapter is active and listening, sets the expectation for what happens next, and provides the context for creating a binding reactively (once messages arrive, the "Route this chat" action becomes available).

#### Recommendation for DorkOS: The Three-Tier Nudge System

```
Tier 1 — Persistent inline badge (always visible, never blocking):
  Adapter card: amber dot + "No agent bound" text
  Disappears automatically when any binding is created.

Tier 2 — Contextual banner (visible when viewing the adapter detail):
  "This adapter is receiving messages but no agent is assigned.
   Messages are being held in dead letter.  [Bind to Agent ▶]"
  Dismissible. Reappears if condition persists after page reload.

Tier 3 — One-time toast (shown once, immediately after adapter creation):
  "Adapter connected. Bind it to an agent to start routing messages."
  Never repeats. No "don't show again" toggle needed.
```

**What NOT to do**:

- No modals requiring binding before the adapter can be used
- No toast that repeats every time the user opens the relay panel
- No disabling the adapter or hiding messages because there's no binding

---

### 2. Live Data Pickers for Routing Configuration

**Finding**: The two canonical patterns are (a) Discord's server-aware `channel_select` that auto-populates from live Discord entities, and (b) Slack's `external_select` that loads options from a developer-specified URL on each open. For DorkOS, neither pattern applies directly — we need a hybrid: a picker populated from the adapter's observed message history, not from an external API.

#### Discord: Auto-Populated Entity Selectors

Discord bots can use four specialized select menu types that auto-populate from live server data without any developer-side option management:

- `channel_select` — populates with all channels the bot can see; filterable by channel type (text, voice, forum, etc.)
- `user_select` — populates with server members
- `role_select` — populates with server roles
- `mentionable_select` — unions of users and roles

**Key design principle**: "Discord provides options to the user automatically, rather than developers needing to create and pass options." The user sees a searchable, filtered list of real entities. The app just gets back the selected entity IDs. — [Select Menus — discord.js Guide](https://discordjs.guide/interactive-components/select-menus.html)

**Applied to DorkOS**: The DorkOS equivalent would be an "agent select" that auto-populates from the mesh's registered agents. The user never types an agent ID — they pick from a searchable list of real, running agents. This is exactly the right model for the binding creation flow.

#### Slack Block Kit: External Select and Conversation Select

Slack's Block Kit offers two relevant picker types:

**`conversations_select`**: Pre-populated with all channels and DMs visible to the user. Key feature: `default_to_current_conversation` — when used in a modal opened from within a conversation, it pre-fills with that conversation. This is brilliant UX: the user opened the modal from a specific conversation, so that's the most likely routing target. — [Select menu element — Slack Developer Docs](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/)

**`external_select`**: Loads options from a developer-specified URL each time the picker opens (or when the user types, for typeahead). Maximum 100 options per response. The developer controls what appears in the list — it's not pre-populated from Slack's data. This is the pattern for domain-specific pickers like "which agent should handle this?"

**The `min_query_length` trick**: Setting `min_query_length: 0` forces Slack to load options immediately when the picker opens (no typing required). This ensures users see all available options right away, not just after typing.

**Applied to DorkOS**: The binding creation picker (when the user clicks "Route to Agent ▾" on a conversation row) should use the external_select model: load all registered agents immediately on open, allow typeahead filtering, show the agent's name + working directory as secondary text.

#### The "Route from Message" Pattern: Gmail + Discord Hybrid

The most powerful live-data picker pattern for DorkOS is a hybrid:

1. **Messages arrive** → appear in InboxView/ConversationRow grouped by chat
2. **User sees the chat context** → already knows what they're routing (it's visible)
3. **User clicks "Route to Agent ▾"** → agent picker opens, pre-filtered to agents not already bound to this chat
4. **User selects agent** → binding is created with chatId auto-populated from the message metadata

**This is the Gmail "Filter messages like this" pattern applied to agent routing**: the user doesn't specify what to route — they point at an existing message and say "route things like this." The system fills in the filter criteria (chatId, adapterId) automatically. — [Create rules to filter your emails — Gmail Help](https://support.google.com/mail/answer/6579?hl=en)

#### Empty State: "No Messages Yet" Handling

The critical edge case: the user wants to create a specific chat binding before any messages have arrived.

**Options**:

1. **Manual entry fallback**: Show a text field for chat ID when no messages exist. Label it clearly: "Chat ID (or wait for a message to arrive and use 'Route to Agent' from the message log)."
2. **Deferred binding creation**: Catch-all bindings work immediately; specific bindings are created reactively. No need to force proactive chat ID entry.
3. **"Test message" prompt**: On the empty state, show: "Send a test message from [adapter] to see chats appear here." This guides the user to the reactive creation path.

**Recommendation**: Option 2 (deferred/reactive) is the DorkOS philosophy. Catch-all handles everything until specific routing is needed. When a message arrives, the "Route to Agent" action appears. No manual chat ID entry required for the happy path.

#### Filtering the Picker: "Show Only Adapters for This Agent"

When the user is viewing a specific agent and opens the RelayPanel, the sidebar should filter to show only adapters bound to that agent. The filter state should be:

- Communicated as filter chips in the panel header: `[Agent: Builder ✕]`
- Accessible via a "Show all" link that removes the filter
- Sticky for the session (clearing on page refresh is acceptable)

This is the Linear model applied to DorkOS: context-aware sidebar that scopes to the current selection. — [Custom Views — Linear Docs](https://linear.app/docs/custom-views)

---

### 3. Binding/Routing Duplication Patterns

**Finding**: Every major automation platform converges on the same three rules for duplication: (1) copy all configuration fields verbatim, (2) reset unique/external-identity fields (webhook URLs, trigger IDs, generated tokens), (3) name the copy with a clear prefix/suffix convention that makes the relationship to the original obvious.

#### Zapier: "Copy of [name]" Convention

Zapier is the most documented platform for duplication behavior:

**Full Zap duplication**:

- New Zap appears as `"Copy of [original Zap name]"` in the dashboard
- All steps are copied verbatim
- **Connections preserved**: any app connections the user has access to remain set up (including shared team connections)
- **Webhook URLs reset**: if the Zap uses a webhook trigger, the duplicate gets a _new_ webhook URL — it cannot share the same URL as the original
- **Other users' private connections**: not transferred; the duplicate shows "needs connection" for those steps
- The copy starts in **draft (off) state**, not active — prevents accidental double-processing
- Source: [Duplicate your Zap — Zapier Help](https://help.zapier.com/hc/en-us/articles/15408145778829-Duplicate-your-Zap)

**Step-level duplication** (within a Zap):

- Duplicated step appears below the original with `"Copy"` prepended to the step name
- All field mappings are preserved
- If the event type is changed after duplication, all field mappings break (expected)
- Source: [Reorder or duplicate action steps — Zapier Help](https://help.zapier.com/hc/en-us/articles/9528974130957-Reorder-or-duplicate-action-steps-and-paths)

#### n8n: Manual Name Required

n8n's workflow duplication prompts the user to enter a name for the duplicate before saving. There is no auto-generated name convention. This causes friction — users must think of a name at duplication time rather than editing the default later.

**What gets preserved**: workflow structure, all node configurations, tags. **What requires attention**: credentials (especially OAuth) may need re-linking; webhook paths need manual uniquification. — [Workflow management — n8n Docs](https://docs.n8n.io/embed/managing-workflows/)

**The webhook uniqueness problem**: When duplicating a workflow that contains a webhook trigger, the webhook path is copied verbatim. Two workflows with the same webhook path cannot both be active. n8n requires users to manually change the path — this is a well-documented pain point in the community. — [When we copy paste a workflow — n8n Community](https://community.n8n.io/t/when-we-copy-paste-a-workflow-to-a-new-workflow-is-there-a-way-to-have-all-the-webhooks-become-unique/178723)

**Lesson for DorkOS**: Any field that must be globally unique (adapter token, webhook endpoint slug) must be reset on duplication. The system should auto-generate a new placeholder value, not silently copy the original.

#### The Universal Duplication Contract

Synthesizing across all platforms, the duplication contract is:

| Field Type                                                       | Duplication Behavior                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| User-specified configuration (form fields, credentials)          | Copied verbatim                                                   |
| Display name / label                                             | Prefixed with "Copy of "                                          |
| Active/enabled state                                             | Reset to **inactive/draft**                                       |
| Unique external identifiers (webhook URLs, bot tokens, API keys) | **Reset / regenerated**                                           |
| Generated IDs (database primary keys)                            | **New ID assigned**                                               |
| Routing rules / bindings                                         | Copied verbatim (user's intent is to start from the same routing) |
| Message history / logs                                           | **Not copied** (belongs to the original)                          |
| Creation timestamp                                               | Set to duplication time                                           |

#### Applied to DorkOS Bindings

For **binding duplication** (the most common use case — "I want to route this chat to a different agent, starting from the same configuration"):

1. **Copy**: channelType, sessionStrategy, all field values
2. **Reset**: the specific chatId (user will pick a different one), the binding's `id`
3. **Name**: `"Copy of [original binding label]"` or just open the edit dialog immediately so the user can set the chatId from the picker
4. **State**: active immediately (unlike Zap duplication, bindings don't have a draft state — they should be live once created)

**Alternative UX**: Instead of "Duplicate," offer "Add similar binding" which opens the binding creation dialog pre-filled with the same agent and channel type, but with chatId empty. This is more transparent than a full clone with unexplained reset behavior.

---

### 4. Connection/Integration Status Indicators

**Finding**: The best status indicator systems use a five-state model, encode state with both color and icon (not color alone), and layer three levels of detail — card badge (scan level), detail banner (investigate level), and log/event stream (debug level).

#### Carbon Design System: Five-State Status Model

The most thorough status indicator specification in any design system. Carbon defines five states with specific semantic meanings:

| State             | Color        | Semantic                                                | When to Use                                              |
| ----------------- | ------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| **Success**       | Green        | Process complete, system healthy                        | Active binding + messages flowing                        |
| **Caution**       | Yellow/Amber | Non-critical issue; action needed to prevent escalation | Adapter connected, no binding                            |
| **Warning**       | Orange       | Threshold breached; near-critical                       | Adapter connected, binding exists but no recent messages |
| **Critical**      | Red          | Failure requiring immediate attention                   | Adapter connection failed, auth error                    |
| **Informational** | Blue         | Context, not urgency                                    | Adapter paused intentionally by user                     |

**Accessibility principle**: "Shape indicators rely solely on shapes and colors, which might not provide enough accessibility for screen readers and individuals with low color vision. Therefore, using outlines and pairing text with shape indicators is essential." — [Status indicators — Carbon Design System v10](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)

Always pair a status dot with a text label. Never rely on color alone.

#### Datadog Integration Tile Model: Applied to DorkOS Adapters

Translating Datadog's three-tier model to DorkOS adapter cards:

```
Adapter state mapping:
┌──────────────────────────────────────────────────────┐
│ Datadog: "Available"  → DorkOS: Not yet added        │
│ (shown in catalog only, not in active adapter list)  │
├──────────────────────────────────────────────────────┤
│ Datadog: "Detected"   → DorkOS: Connected, no binding│
│ ● Yellow dot   "Connected — no agent bound"          │
│ Sub-text: "Messages going to dead letter"            │
├──────────────────────────────────────────────────────┤
│ Datadog: "Installed"  → DorkOS: Connected + binding  │
│ ● Green dot    "Routing to [Agent Name]"             │
│ Sub-text: "12 messages today"                        │
├──────────────────────────────────────────────────────┤
│ (No Datadog equivalent) → DorkOS: Error              │
│ ● Red dot      "Connection error"                    │
│ Sub-text: "Last successful: 2h ago · [Reconnect]"   │
└──────────────────────────────────────────────────────┘
```

#### Stripe: Progressive Restriction Cascade

The Stripe model introduces temporal dimension to status — not just current state but future state:

```
Stripe status cascade applied to DorkOS:
1. Connected + binding active  → Enabled (green)
2. Connected + binding paused  → Informational (blue) "Paused by you"
3. Connected + no binding      → Caution (amber) "Action recommended"
4. Connection error + binding  → Warning (orange) "Routing suspended"
5. Auth failure                → Critical (red) "Action required"
6. Intentionally disabled      → Informational (blue) "Disabled"
```

The key Stripe insight: distinguish "user chose to pause this" (informational) from "this needs your attention" (caution/warning). Users who pause adapters intentionally shouldn't see amber badges — that would be noise.

#### Home Assistant: "Needs Attention" as Persistent Card Badge

Home Assistant's integration cards show persistent state badges that don't require user interaction:

- Normal integration: just the name + entity count
- Failed integration: `⚠ Failed setup, will retry` in small text below the card name
- Needs attention: `⚠ Attention required` badge, red background

**Critical UX detail**: The attention badge is on the card in the list, not just inside the detail view. This means users can scan the integrations page and immediately see which ones need work without clicking into each one. — [Home Assistant community — Needs Attention](https://community.home-assistant.io/t/integrations-triple-card-for-airvisual-with-attention-required-status/234420)

**Applied to DorkOS**: The adapter list in RelayPanel should be scannable at a glance. Status dots on each card = instant health overview without opening any detail view.

#### Hookdeck: Topology-Level Status Encoding

Hookdeck's canvas UI encodes connection health visually at the topology level:

- Active connection: solid line between source and destination
- Paused connection: **disconnected yellow/amber line** (literally a gap in the wire)
- Error: red line or X indicator on the connection edge

This is the topology-view equivalent of the card badge. For DorkOS's React Flow topology:

- Adapter → Agent binding edge: green solid line (healthy)
- No binding: no edge (adapter node floats, disconnected)
- Error: red edge or dashed line
- Paused: amber dashed line

The "dangling adapter node with no edges" is itself a status indicator. It's visually obvious that something is unconnected, without any badge or label. — [Hookdeck Connections](https://hookdeck.com/docs/connections)

#### Pencil & Paper: Matching Prominence to Risk Level

The core principle for status notification design: "Design should match notification prominence to actual risk level." — [Error Message UX — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback)

| Risk Level          | DorkOS Adapter State               | Notification Pattern               |
| ------------------- | ---------------------------------- | ---------------------------------- |
| Low (informational) | Adapter paused by user             | Small blue badge only              |
| Medium (caution)    | Connected, no binding              | Amber dot + text on card           |
| High (warning)      | Binding exists, no recent messages | Orange dot + banner in detail view |
| Critical            | Auth failure, repeated errors      | Red dot + banner + one-time toast  |

**The escalation rule**: if the problem has existed for more than N hours, escalate the notification prominence. An adapter that has been unbound for 10 minutes is informational. An adapter that has been unbound for 7 days is more urgent.

---

## Detailed Analysis

### Synthesis: A Unified Status Model for DorkOS Adapters

Drawing on all four sources (Datadog, Stripe, Home Assistant, Carbon), here is the recommended state model for DorkOS adapter + binding health:

```
State: CONNECTED_ROUTING (healthy)
  Condition: adapter connected + ≥1 active binding + messages in last 24h
  Visual: ● Green dot  "Routing to [Agent]"
  Card badge: green dot
  Topology: green solid edge(s)
  Action: none required

State: CONNECTED_IDLE (informational)
  Condition: adapter connected + ≥1 active binding + 0 messages in last 24h
  Visual: ● Blue dot  "Connected — no recent messages"
  Card badge: blue dot
  Topology: blue solid edge(s)
  Action: none required (may be intentional — not all adapters are busy)

State: CONNECTED_UNBOUND (caution — needs action)
  Condition: adapter connected + 0 active bindings
  Visual: ● Amber dot  "No agent bound"
  Card badge: amber dot with "!" indicator
  Topology: adapter node with no edges (floating)
  Inline action: "Bind to Agent ▶" link on card
  Banner (detail view): "Messages are going to dead letter. Bind this adapter to route them."

State: CONNECTED_ERROR (warning — binding exists but routing failing)
  Condition: adapter connected + binding active + routing errors in last N minutes
  Visual: ● Orange dot  "Routing errors"
  Card badge: orange dot
  Topology: orange dashed edge
  Banner (detail view): error details + retry action

State: CONNECTION_FAILED (critical — needs immediate action)
  Condition: adapter connection failing (auth error, network, bad token)
  Visual: ● Red dot  "Connection failed"
  Card badge: red dot
  Topology: red X on adapter node
  Toast: one-time "Adapter [name] connection failed. [Fix it ▶]"
  Banner (detail view): error message + reconnect action

State: PAUSED (informational — user intent)
  Condition: adapter or binding explicitly paused by user
  Visual: ● Gray dot  "Paused"
  Card badge: gray dot
  Topology: gray dashed edge
  Action: "Resume" button on card
```

### The Naming Convention for Binding Duplication

Based on the Zapier, n8n, and Make.com research, the recommended naming convention for DorkOS:

**Duplicating a binding**:

- Default label: `"[original label] (copy)"` — suffix rather than prefix, more scannable in sorted lists
- Immediately open the binding edit dialog so the user can adjust fields (especially chatId if they're routing a different chat)
- The copy starts active (unlike Zap duplication) since bindings don't have draft state

**Duplicating an adapter instance**:

- Default label: `"[original label] (copy)"` — same pattern
- The adapter token field shows a placeholder: "Enter new token — original token not copied"
- The copy starts with the setup wizard at step 2 (configure credentials) since a new token is required
- No binding is copied — the user will need to set up bindings fresh (they might want to copy them too, but that's a separate action)

**The reset rule**: anything that involves an external system's identity (API token, webhook URL, bot token) must be reset and clearly flagged. Configuration preferences (channel type, session strategy, display name structure) are copied.

### The Empty-State Sequencing Problem

A subtle UX problem: the user creates an adapter but wants to set up a specific chat binding before any messages have arrived. The reactive "Route to Agent" pattern requires a message to exist first.

**The solution hierarchy** (in order of preference):

1. **Deferred**: Catch-all binding handles all chats until specific routing is needed. User creates specific bindings reactively as chats appear. Zero friction.
2. **Manual ID entry**: In the binding creation form, show a text field for chatId with the label "Chat ID" and hint text "Or wait for a message to arrive and use the 'Route' button in the message log." This is the escape hatch for power users who know their chat IDs.
3. **"Send a test message" prompt**: In the empty message log state, show a prompt with the adapter's configuration (e.g., the bot username) so the user can send a test message to get the chat ID to appear.

Option 1 (deferred/reactive) covers 90% of cases. Option 2 is the developer escape hatch. Option 3 is the guided path for users who don't yet know their chat IDs.

---

## Security Considerations

- **Adapter token duplication must be blocked**: When duplicating an adapter, the original bot token, API key, or webhook secret must never be copied to the duplicate. The duplicate must show a placeholder prompting the user to enter a new credential. Silently copying credentials would create two adapters sharing one token, which is both a security risk and would cause message delivery confusion.
- **Binding chatId visibility**: ChatIds from Telegram or other platforms are not sensitive, but they are PII-adjacent. Do not expose chatIds in URLs or shareable links. Keep them in the binding store, not query parameters.
- **Dead letter message retention**: Messages going to dead letter because there's no binding should have a retention limit (e.g., 72 hours). Do not accumulate unbounded dead letter messages — this is both a storage concern and a privacy concern (messages from users who expected them to be processed).

---

## Performance Considerations

- **Live-data picker population**: The agent picker in the "Route to Agent" dropdown should be populated from the mesh's agent registry, which is already in memory on the server. This is a fast local lookup, not an external API call. The picker should load instantly (< 50ms).
- **Status badge computation**: Adapter health state should be computed server-side and cached, not computed per-render in the client. The status (connected, routing, error, etc.) should be part of the adapter's SSE event stream so clients receive updates without polling.
- **Message log for reactive binding**: Conversation rows in InboxView are already fetched for the message log. The "Route to Agent" button on each row adds no additional data fetching — it just opens a picker that loads agents from the already-cached registry.
- **Duplication at scale**: If an adapter has many specific bindings (e.g., 50 chat-level bindings), duplicating the adapter's binding set is a non-trivial database operation. Add a confirmation step: "This will copy [N] bindings. Are you sure?"

---

## Recommendation

### Post-Setup Nudges: Adopt the Amber Dot + One-Time Toast Model

Use the Datadog/Home Assistant inline badge pattern, not modal blocking:

1. Amber dot on the adapter card = "connected but not routing"
2. One-time toast after adapter creation = "Bind to an agent to start routing"
3. Contextual banner in the adapter detail view = persistent until binding created

Do not block any functionality. The adapter is usable (messages go to dead letter) even without a binding. The badge communicates the state; it does not prevent action.

### Live Pickers: Reactive "Route to Agent" on Conversation Rows

Do not build a proactive chat-ID picker. Let messages arrive first, then expose the "Route to Agent" dropdown on each conversation group in the InboxView. The agent picker populates from the mesh registry (instant). The chatId is auto-filled from message metadata. Manual chatId entry is the fallback for power users.

### Duplication: "Add similar binding" Over "Duplicate"

Label the action "Add similar binding" rather than "Duplicate binding." This sets the right expectation: you're starting from a template, not creating an identical copy. Open the binding creation dialog pre-filled with all fields except chatId (which the user must select). This is more transparent than silent cloning.

For adapter duplication, require the user to enter a new token before the duplicate adapter is saved. Never copy tokens silently.

### Status Indicators: Five-State Model with Mandatory Text Labels

Implement the five states from Carbon Design System semantics:

- Green = routing (healthy)
- Blue = idle (connected, no recent messages, no action needed)
- Amber = unbound (action recommended)
- Orange = errors (action required)
- Red = connection failed (action required, most urgent)

Always pair the dot with a text label. Use these same states in both the adapter card list view (dot only, for scannability) and the topology view (edge color + node border color). Never rely on color alone — pair with icon and label for accessibility.

---

## Sources & Evidence

### Post-Setup Incomplete Configuration Patterns

- [Review and take action on connected accounts — Stripe Docs](https://docs.stripe.com/connect/dashboard/review-actionable-accounts) — Progressive restriction UX, "Actions required" section
- [Account onboarding — Stripe Documentation](https://docs.stripe.com/connect/supported-embedded-components/account-onboarding) — Stripe's onboarding state model
- [Introduction to Integrations — Datadog](https://docs.datadoghq.com/getting_started/integrations/) — "Available / Detected / Installed" three-tier status
- [Home Assistant "Needs Attention" — GitHub Issue #116566](https://github.com/home-assistant/core/issues/116566) — "Needs attention" badge pattern on integration cards
- [Home Assistant "Attention Required" community thread](https://community.home-assistant.io/t/integrations-triple-card-for-airvisual-with-attention-required-status/234420) — Visual badge behavior
- [Introduction to errors and warnings in Make — Make.com](https://www.make.com/en/help/errors/introduction-to-errors-and-warnings-in-make) — Warning sign on unconfigured canvas modules
- [Connections — Hookdeck](https://hookdeck.com/docs/connections) — Active/paused/disabled connection states; yellow disconnected line pattern
- [Error Message UX — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback) — "Match notification prominence to actual risk level" principle

### Live Data Pickers

- [Select menu element — Slack Developer Docs](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/) — `conversations_select`, `external_select`, `default_to_current_conversation`
- [Select Menus — discord.js Guide](https://discordjs.guide/interactive-components/select-menus.html) — `channel_select`, `user_select`, auto-populated from server entities
- [Create rules to filter your emails — Gmail Help](https://support.google.com/mail/answer/6579?hl=en) — "Filter messages like this" reactive filter creation pattern
- [Filter emails in Gmail — Ablebits](https://www.ablebits.com/office-addins-blog/filter-email-gmail/) — Step-by-step "filter from message" flow

### Binding/Routing Duplication Patterns

- [Duplicate your Zap — Zapier Help](https://help.zapier.com/hc/en-us/articles/15408145778829-Duplicate-your-Zap) — "Copy of [name]" convention, connection preservation, webhook URL reset
- [Reorder or duplicate action steps — Zapier Help](https://help.zapier.com/hc/en-us/articles/9528974130957-Reorder-or-duplicate-action-steps-and-paths) — Step-level "Copy" prefix pattern
- [Copy and paste steps between Zaps — Zapier Help](https://help.zapier.com/hc/en-us/articles/14166765028749-Copy-and-paste-steps-between-Zaps) — Cross-Zap step copying behavior
- [Workflow management — n8n Docs](https://docs.n8n.io/embed/managing-workflows/) — Manual name required on duplication
- [Webhook uniqueness on duplication — n8n Community](https://community.n8n.io/t/when-we-copy-paste-a-workflow-to-a-new-workflow-is-there-a-way-to-have-all-the-webhooks-become-unique/178723) — The webhook path uniqueness problem

### Connection Status Indicators

- [Status indicators — Carbon Design System v10](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/) — Five-state model: Success / Caution / Warning / Critical / Informational
- [Connections — Hookdeck](https://hookdeck.com/docs/connections) — Paused = disconnected yellow line on canvas
- [Introduction to Integrations — Datadog](https://docs.datadoghq.com/getting_started/integrations/) — Three-tier: Available / Detected / Installed
- [Getting Integrations Working — Datadog Docs](https://docs.datadoghq.com/agent/troubleshooting/integrations/) — Yellow = misconfigured, green = healthy
- [Error Message UX — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback) — Risk-proportionate notification design

---

## Research Gaps & Limitations

- **Railway.app and Render.com** specific UX patterns for incomplete service configuration were not directly accessible. The research relied on community forum posts rather than first-party documentation. Both platforms appear to handle incomplete configuration through deployment failures rather than preemptive UI indicators — a pattern DorkOS should NOT adopt.
- **Twilio Console** "not configured" phone number state was researched but the specific visual indicator (if any) in the console dashboard was not confirmed. Twilio's model appears to be: phone numbers work (receive calls/messages) but without a webhook configured, Twilio returns a 404 TwiML response rather than showing a UI warning.
- **Discord bot-level status** in the developer portal (as opposed to the select menu API) was not researched. There may be additional patterns in Discord's application dashboard.
- **Mobile/responsive behavior** of the proposed status badge system was not researched. The dot + text label approach should be accessible on small screens, but specific breakpoint behavior is not specified here.
- **The 5-state escalation timing** (when does "amber/caution" become "orange/warning" based on time elapsed) requires a product decision, not just UX research. The recommendation is to start with a simple binary: unbound = amber, connected + routing = green. Add temporal escalation in a future iteration.

---

## Contradictions & Disputes

- **Blocking vs non-blocking setup**: Make.com blocks scenario activation if any module is unconfigured. Stripe/Home Assistant never block. For DorkOS, non-blocking is the correct choice — Kai (the primary persona) will intentionally create adapters without bindings as part of testing or staged rollouts. Blocking him would be condescending.
- **"Copy of" prefix vs "(copy)" suffix**: Zapier uses prefix (`"Copy of [name]"`). Some design systems use suffix (`"[name] (copy)"`). The suffix pattern is more scannable in alphabetically sorted lists because the original name appears first. Recommendation: use suffix `"[name] (copy)"` for DorkOS.
- **Start active vs start paused on duplication**: Zapier starts duplicated Zaps as drafts/off. This makes sense for Zaps because an active duplicate could double-process triggers. For DorkOS bindings, a duplicate binding routes to a different chat (the user will have changed the chatId) so double-routing is not a concern — bindings should start active immediately.

---

## Search Methodology

- Searches performed: 22
- Most productive search terms: "Zapier Zap clone duplicate fields copied", "Discord channel_select user_select auto-populated", "Stripe action required banner developer dashboard", "Carbon Design System status indicator five states", "Hookdeck paused connection yellow line"
- Primary information sources: Zapier Help Center, Stripe Docs, Discord Developer Docs, Slack Block Kit Docs, Datadog Docs, Home Assistant Community, Carbon Design System v10, Hookdeck Docs, Pencil & Paper UX
- Companion research: `20260311_adapter_binding_configuration_ux_patterns.md` (prior deep research covering Zapier labeling, Intercom routing, progressive disclosure, Gmail filter creation)
