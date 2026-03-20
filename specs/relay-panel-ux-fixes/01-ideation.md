---
slug: relay-panel-ux-fixes
number: 134
created: 2026-03-15
status: ideation
---

# Relay Panel Design Critique v2

**Reviewers:** Steve Jobs & Jony Ive (channeled)
**Date:** 2026-03-15
**Scope:** Complete Relay Panel — every screen, every interaction, every state
**Status:** Living document — updated as we trace each surface

---

## Executive Summary

The Relay Panel redesign moved from four system-architecture tabs to two. That was right. But the execution stopped halfway. We removed the Bindings tab and the Endpoints tab — good, they mirrored internals — but we forgot to give users a way to do what those tabs _did_. We removed the noun and forgot to preserve the verb.

The result is a panel that looks cleaner but is functionally broken. A user who needs to add a second binding to an adapter, edit any binding, or delete a binding simply cannot. The only binding creation path is the wizard's final step (first-time setup only) and the "Route" button on dead letter conversations. After that initial moment, bindings are frozen in amber.

This is not a minor gap. This is the core interaction of the entire panel.

---

## Screen-by-Screen Critique

### 1. Dialog Chrome — The Title

**What we see:** `ResponsiveDialogTitle` reads simply "Relay".

**Steve:** "Relay" is a system concept. It tells the user nothing about what they're looking at or what they can do. When I open this dialog, I need to know: what is this _for_? Compare: "Pulse Scheduler" — that tells me exactly what I'm about to do. "Relay" is like naming the Finder "Filesystem."

**Jony:** The title should earn its space. It should orient the user in a single glance. "Relay" is technically accurate and emotionally vacant. It communicates nothing about the user's relationship to this surface.

**Recommendation:**

- Rename to **"Connections"** — this is what users think about. "How are my agents connected to the world?"
- Alternative: **"Adapters & Activity"** — descriptive but less elegant
- The `sr-only` description says "Inter-agent messaging activity and endpoints" — this is engineer-speak. Nobody thinks "I need to check my inter-agent messaging endpoints."

**Severity:** Medium. Confusing, not blocking.

---

### 2. Health Bar — The Clickable Status Message

**What we see:** Red dot + "85% failure rate — 3,852 messages failed today". Clickable. Clicking switches to Activity tab and scrolls to... nothing visible.

**Steve:** This is the worst kind of promise-and-betray pattern. You tell me something is critically wrong. You make the text clickable, implying "click here to see what's wrong." I click. And I see... an empty activity feed with a ghost preview saying "Waiting for messages." You just told me 3,852 messages failed and now you're showing me an empty inbox? That's insulting to the user's intelligence.

**Jony:** The failure is in the information architecture. The health bar aggregates metrics. The activity feed shows individual conversations. The dead letter section shows aggregated failures. But the dead letter section is hidden behind a toggle. So the click target scrolls to a section that doesn't exist until the user manually presses "Failures." This is a two-step interaction disguised as a one-step interaction.

**Root cause analysis:**

1. `handleFailedClick` calls `setActiveTab('activity')` then `deadLetterRef.current?.scrollIntoView()`
2. But `DeadLetterSection` only renders when `showFailures` is `true`
3. `showFailures` defaults to `false`
4. So the ref target doesn't exist in the DOM when `scrollIntoView` fires
5. The `setTimeout(..., 0)` was meant to wait for tab render, but it doesn't wait for the Failures toggle

**Recommendation:**

- When the health bar status is clicked, it should: (a) switch to Activity tab, (b) set `showFailures = true`, AND (c) scroll to dead letters
- The `handleFailedClick` in `RelayPanel.tsx` needs to pass a signal to `ActivityFeed` that auto-opens the failures section
- Better yet: if there are dead letters, the Failures section should be open by default. Hiding known failures behind a toggle is hiding the fire alarm behind a cabinet door.

**Severity:** Critical. Broken interaction path. User sees "things are on fire" but clicking leads to an empty screen.

---

### 3. Health Bar — The Metrics Icon

**What we see:** A tiny BarChart3 icon button that opens a "Delivery Metrics" dialog with total/delivered/failed/dead-letter counts, latency, and budget rejections.

**Steve:** Why is this a separate dialog? The user already has the Activity tab open. They're already looking at the relay panel. Why do they need to open _another_ dialog on top of the dialog they're in? Dialog-on-dialog is a symptom of not knowing where information belongs.

**Jony:** The metrics dashboard contains precisely the information that should contextualize the Activity tab. When I'm looking at my message activity, I want to see "how are things going overall" as ambient context — not as a popup I have to explicitly request.

**Current metrics shown:**

- Total messages / Delivered / Failed / Dead Letter (counts)
- Avg latency / P95 latency
- Active subjects count
- Budget rejections (hop limit, TTL expired, cycle detected, budget exhausted)

**Recommendation:**

- Remove the DeliveryMetrics dialog entirely
- Place a compact metrics summary at the top of the Activity tab — 4 stat cards: Total, Delivered, Failed, Dead Letter
- Or, integrate metrics into the health bar itself with a hover tooltip (which already exists! The healthy state already has a tooltip showing "X messages today, Y failed, Zms avg latency")
- Budget rejections belong in the dead letter section, not a separate dialog — they're literally the reasons dead letters exist
- The BarChart3 icon is 24x24 pixels. It's an implementation detail masquerading as a feature.

**Severity:** Medium. Not broken, but bad information architecture. Data exists in a place users won't find it.

---

### 4. Activity Tab — Empty By Default

**What we see:** Activity tab shows "Waiting for messages" ghost preview even though there are thousands of messages. The filter bar has "All sources" and "All statuses" selected, which should show everything.

**Steve:** If I have 3,852 failed messages and I click to the Activity tab and it's empty, something is fundamentally wrong. The health bar just told me there's a fire. The activity tab says "nothing to see here." These two surfaces are contradicting each other.

**Jony:** The distinction is that the health bar reads from `useDeliveryMetrics()` (aggregated counters from the server) while the activity feed reads from `useRelayConversations()` (individual conversation records). If the conversations endpoint returns empty while metrics show thousands of messages, either: (a) the conversations query is filtered or paginated in a way that excludes them, or (b) conversations are only populated from SSE events after the dialog opens, not historical data.

**Investigation needed:** The `useRelayConversations` hook may only return conversations observed during the current SSE session, not historical ones. If so, the activity feed is not a "feed" — it's a real-time monitor that starts empty every time you open the panel. That's a completely different mental model than what users expect.

**Recommendation:**

- The Activity tab MUST show historical data. If conversations are SSE-only, the server needs to persist and serve them via REST.
- If conversations ARE served via REST but the query returns empty, debug why
- The empty state should NEVER appear when the health bar shows active message counts. These two surfaces must be consistent.
- If we truly only have real-time monitoring (no history), the copy should say that: "Live monitor — messages appear here in real time" not "Waiting for messages" which implies nothing has happened.

**Severity:** Critical. The primary data surface shows no data when data exists.

---

### 5. Activity Tab — "Failed" Filter vs. "Failures" Button

**What we see:** Two controls that sound like the same thing:

1. Status dropdown with "Failed" option — filters conversation list to `status === 'failed'`
2. "Failures" button (with AlertTriangle icon) — toggles visibility of DeadLetterSection

**Steve:** This is exactly the kind of thing that happens when engineers design UIs. You have two different system concepts — failed conversations and dead-lettered messages — and you expose both to the user with nearly identical names. The user doesn't know the difference. They shouldn't have to.

**Jony:** The distinction is real but the labeling collapses it. A "failed" conversation is one that was attempted and failed during delivery. A "dead letter" is a message that was rejected before delivery (hop limit, cycle, budget). These are different categories of failure, but to the user, they're all "things that went wrong."

**What each control does:**

- **"Failed" in status dropdown:** Filters the conversation list to show only conversations with `status === 'failed'`. These are messages that found a route but delivery failed.
- **"Failures" button:** Toggles a _completely separate section_ (`DeadLetterSection`) that shows aggregated dead letters — messages that never found a route or were rejected by budget policies.

**Problems:**

1. The names are too similar — "Failed" vs. "Failures"
2. They operate on different data sources (conversations vs. dead letters)
3. One is a filter (modifies the existing list), the other is a toggle (shows/hides a section)
4. The "Failures" button has a red dot badge — but only when dead letters exist AND the section is closed. This is alarm fatigue: the dot appears every time you close the section, even after you've reviewed the failures.

**Recommendation:**

- Merge the concepts. All failures — whether delivery failures or dead letters — should appear in one unified view.
- Replace the "Failures" toggle button with a **"Failed & Rejected"** filter option in the status dropdown (or just "Failed" that includes both)
- Dead letter cards can appear inline in the conversation list, sorted by time, with a distinct visual treatment (different card style, warning colors)
- Or: keep the dead letter section but make it always visible when dead letters exist. Don't hide problems behind a toggle.

**Severity:** High. Users will be confused. The mental model is split in two for no user-facing reason.

---

### 6. Binding Management — The Missing Feature

**What we see:** Nowhere in the current interface can a user:

- Add a binding to an existing adapter (only during initial wizard setup)
- Edit any binding (session strategy, permissions, chat filter)
- Delete a binding
- View a full list of all bindings across adapters

**Steve:** You removed the Bindings tab because it was "redundant with inline AdapterCard bindings." But AdapterCard only _displays_ binding rows — it has no create, edit, or delete actions. You deleted the only CRUD surface and replaced it with a read-only display. That's like removing the Trash can from the Finder because "files are already shown in their folders."

**Jony:** The BindingList component still exists in the codebase (`apps/client/src/layers/features/relay/ui/BindingList.tsx`) with full create, edit, duplicate, and delete functionality. But nothing imports it. It's dead code. The BindingDialog also exists with complete edit mode support. Both are orphaned.

**Where bindings CAN be created today:**

1. Wizard BindStep — only during first-time adapter setup
2. ConversationRow "Route" button — only from dead letter/activity conversations
3. ConversationRow "More options..." — opens BindingDialog in create mode

**Where bindings CANNOT be managed:**

- AdapterCard shows bindings but has no add/edit/delete actions
- ConnectionsTab has no binding management
- No "Manage Bindings" option in the adapter kebab menu
- No way to reach the BindingDialog in edit mode from anywhere

**Consequences:**

- If a user creates an adapter and skips the bind step, they can never add a binding later (except through dead letter routing)
- If a user sets the wrong session strategy, they can never change it
- If a user enables `canInitiate` by mistake, they can never disable it
- If a user wants to remove a binding, they must remove and re-add the entire adapter

**Recommendation:**

- Add a **"Manage Bindings"** action to the AdapterCard kebab menu — opens BindingList filtered to that adapter
- Or: add inline binding management directly on AdapterCard — add button, click-to-edit on each binding row, delete on each row
- The AdapterCard already has the binding data and agent lookup. It just needs the verbs.
- Consider: the "No agent bound" amber state on a connected adapter should have a CTA: "Add binding" or "Bind to agent"

**Severity:** Critical. Users cannot manage the core configuration object of the relay system.

---

### 7. AdapterCard — Binding Display

**What we see:** Each adapter card shows up to 3 `AdapterBindingRow` components with agent name, session strategy badge (only if non-default), and permission indicators (only if non-default). Overflow shows "and X more."

**Steve:** This is actually good. The progressive disclosure is right — show the important stuff, hide the defaults. But it's read-only. It's like a beautiful display case with no door. You can see your bindings but you can't touch them.

**Jony:** The binding rows are well-crafted individually. The decision to suppress default values (per-chat strategy, default permissions) is correct — it respects the principle of showing only what's meaningful. But the "and X more" overflow text is not interactive. It should expand or link to a full binding view.

**Recommendation:**

- Make each `AdapterBindingRow` clickable — opens BindingDialog in edit mode for that binding
- Add a small "+" button after the binding rows — opens BindingDialog in create mode pre-filled with the adapter
- Make "and X more" clickable — expands to show all bindings, or opens a binding list sheet
- The "No agent bound" state should have an "Add binding" button right there, not just amber text

**Severity:** High. The UI displays data it won't let you act on.

---

### 8. Adapter Setup Wizard — BindStep

**What we see:** The final wizard step lets users select one agent and one session strategy. It creates a single binding.

**Steve:** This is fine for first-time setup. One adapter, one agent, get started. But it's the _only_ place in the entire UI where you can create a binding (outside of dead letter routing). That means if you want to bind an adapter to multiple agents — which is the whole point of the binding architecture — you have to use a workaround.

**Jony:** The wizard is well-structured. The step progression (Configure → Test → Confirm → Bind) is clear. The issue isn't the wizard itself — it's that the wizard is the only door into binding creation for normal flows.

**Recommendation:**

- Wizard BindStep is fine as-is for initial setup
- Post-wizard binding management should be accessible from AdapterCard
- Consider adding a brief "you can add more bindings later from the adapter card" note on the BindStep

**Severity:** Low. The wizard itself is fine. The problem is everything after it.

---

### 9. ConversationRow — Route to Agent

**What we see:** Each conversation row has a "Route" button that opens a popover with agent selector + "Create Binding" + "More options..." link.

**Steve:** This is actually clever. You see a failed message, you route it to an agent. It's contextual action where you need it. The "More options..." link correctly opens the full BindingDialog. This is good design.

**Jony:** The interaction is well-considered. The quick route (select agent, create binding) covers the 80% case. "More options..." covers the 20%. The pre-population from conversation metadata (adapterId, chatId, channelType) is thoughtful.

**Issues:**

- The `extractAdapterId` function uses regex on subjects, which the spec noted as broken (pattern mismatch). Was this fixed? If not, quick-route creates bindings with empty adapter IDs.
- The route popover doesn't show existing bindings for context — you might create a duplicate

**Recommendation:**

- Verify `extractAdapterId` works correctly with current subject patterns
- Show a brief note in the popover if a binding already exists for this adapter: "Binding exists: → AgentName"
- This is a secondary binding creation path and it works. The primary path (from AdapterCard) is what's missing.

**Severity:** Low. Works well as a secondary path. Not a substitute for primary binding management.

---

### 10. RelayEmptyState — Mode A

**What we see:** Ghost preview with three faded message rows, "Connect your agents to the world" heading, "Add Adapter" CTA.

**Steve:** This is the right approach. Show people what success looks like, then give them one clear action. The ghost preview creates desire. The CTA is clear. This is good.

**Jony:** The transition from Mode A to Mode B (empty → populated) uses AnimatePresence with a smooth fade. The ghost preview is appropriately subtle — 20% opacity, pointer-events-none. The copy is human, not technical.

**Recommendation:**

- No changes needed. This is one of the best screens in the panel.

**Severity:** None. Well designed.

---

### 11. Activity Empty State — Ghost Preview

**What we see:** When the activity tab has no conversations, it shows ghost preview rows + Inbox icon + "Waiting for messages" copy + "Set up an adapter" button.

**Steve:** The ghost preview is good. The copy... "Waiting for messages" is passive. The system is waiting. But the user should feel empowered, not like they're watching paint dry. And "Set up an adapter" as a CTA from the Activity tab is wrong — if they're on the Activity tab, adapters are already configured (Mode B). The CTA should relate to activity, not setup.

**Jony:** The disconnect is that this empty state appears even when adapters ARE configured and HAVE bindings. The activity feed is empty because no messages have been exchanged yet (or because history isn't loaded — see issue #4). The "Set up an adapter" CTA is misleading in this context.

**Recommendation:**

- Change copy to: "No activity yet" / "Messages will appear here as your agents communicate."
- Remove or change the "Set up an adapter" CTA — if adapters are configured, this is confusing. Replace with: "Send a test message" which opens the ComposeMessageDialog
- If activity is truly real-time-only (no history), say so: "Live activity monitor — messages appear as they arrive"

**Severity:** Medium. Misleading CTA and passive copy.

---

### 12. Dead Letter Section

**What we see:** Aggregated failure cards grouped by source + reason. Each card shows source, reason badge (color-coded), count, time range, "View Sample" button, "Dismiss All" button.

**Steve:** The aggregation is right. Nobody wants to see 3,852 individual failures. Group them, show me the pattern, let me act. "View Sample" and "Dismiss All" are the right actions. But these cards are hidden behind a toggle. Why? If there are failures, show them. Don't make me hunt.

**Jony:** The visual language is good — color-coded reason badges (orange for hop limit, purple for cycle detected, red for budget exhausted) create immediate pattern recognition. The "View Sample" dialog showing raw JSON is the right level of technical detail for the audience.

**Issues:**

- The section is only visible when `showFailures` is toggled on
- The health bar click should auto-show this section (see issue #2)
- "Dismiss All" has no confirmation dialog — one click permanently removes all dead letters for a group
- After dismissing, there's no undo

**Recommendation:**

- Dead letters should be visible by default when they exist — don't hide problems
- Or: integrate dead letter cards into the conversation list with a distinct visual treatment
- Add a confirmation step to "Dismiss All" — "Dismiss 847 dead letters from telegram/hop_limit?"
- Consider "Dismiss All" → "Mark Resolved" (less destructive language)

**Severity:** Medium. Hidden by default when it shouldn't be. No confirmation on destructive action.

---

### 13. DeliveryMetrics Dialog

**What we see:** A dialog that opens from the BarChart3 icon showing message counts, latency, and budget rejections.

**Steve:** I already said this — this shouldn't be a dialog. But let me look at the content. Four stat cards (total, delivered, failed, dead letter), two latency numbers, active subjects count, budget rejections. This is a dashboard without a home. It's useful data floating in a popup.

**Jony:** The stat cards use color coding: green for delivered, red for failed (only when > 0), yellow for dead letter (only when > 0). This is correct — color only when meaningful. The conditional rendering of budget rejections (only when non-zero) is good — don't show empty categories.

**Recommendation:**

- Move this data to the top of the Activity tab as a compact summary row
- Format: `1,234 total | 1,100 delivered | 134 failed | 0 dead letter | 45ms avg`
- Budget rejections should appear in dead letter section, not here
- Delete the BarChart3 icon button and the DeliveryMetrics dialog component

**Severity:** Medium. Data in wrong location. Not blocking.

---

### 14. Connection Status Banner

**What we see:** Inline banner when SSE connection is lost: "Connection lost. Reconnecting..." (amber) or "Connection lost. Check your network." (red).

**Steve:** This is fine. Simple, clear, appropriate urgency. Shows only when needed. Disappears when resolved.

**Jony:** The WifiOff icon and pulsing animation for reconnecting state are appropriately attention-drawing without being alarming. The placement below the health bar and above the tab content is correct.

**Recommendation:** No changes needed.

**Severity:** None. Well designed.

---

### 15. Adapter Event Log (Sheet)

**What we see:** Right-side sheet opened from adapter kebab menu → "Events". Shows real-time event stream with type filter.

**Steve:** This is a developer debugging tool. It's fine to have, but it should feel like a developer tool, not a primary feature. The sheet approach is correct — it's an overlay, not a destination.

**Jony:** The auto-scroll behavior (follow when at bottom, stop when scrolled up) is correct and expected. The "Jump to bottom" button when scrolled up is thoughtful.

**Recommendation:** No changes needed. This is appropriately scoped.

**Severity:** None. Well designed for its purpose.

---

## Consolidated Recommendations — Priority Order

### P0: Fix Now (Broken Interactions)

1. **Binding CRUD from AdapterCard** — Add "Manage Bindings" to kebab menu, or inline add/edit/delete on binding rows. This is the most critical gap. Users cannot manage the core object of the relay system.

2. **Health bar click → auto-open failures** — `handleFailedClick` must set `showFailures = true` AND switch tab AND scroll. Currently switches tab but failures section stays hidden.

3. **Activity tab empty when data exists** — Investigate why `useRelayConversations` returns empty when `useDeliveryMetrics` shows thousands of messages. Either serve historical data or make the empty state honest about being real-time-only.

### P1: Fix Soon (Bad UX)

4. **Merge "Failed" filter and "Failures" toggle** — One concept ("things that went wrong"), not two controls with confusing names. Either integrate dead letters into the conversation list or auto-show the dead letter section when filtering to failed.

5. **Dialog title: "Relay" → "Connections"** — Simple rename. Orient the user.

6. **Move DeliveryMetrics into Activity tab** — Kill the dialog-on-dialog pattern. Show summary stats inline.

7. **Dead letters visible by default** — When dead letters exist, show them. Don't hide fires behind toggles.

### P2: Polish (Good Design)

8. **AdapterCard "No agent bound" → "Add binding" CTA** — Turn the amber warning into an actionable path.

9. **Activity empty state copy** — "No activity yet" instead of "Waiting for messages." Replace "Set up an adapter" CTA with "Send a test message."

10. **"Dismiss All" confirmation** — Add confirmation dialog before permanently removing dead letter groups.

11. **Conversation Row route popover** — Show existing bindings for context before creating duplicates.

---

## The Ive Principle Applied

> "True simplicity is derived from so much more than just the absence of clutter."

We removed clutter (4 tabs → 2, removed Endpoints, removed standalone Bindings). But we forgot that simplicity requires every remaining surface to be complete. A simple interface that can't do what users need is not simple — it's broken.

The path forward: make AdapterCard the single source of truth for adapter + binding management. Connections tab = configure and manage adapters and their bindings. Activity tab = observe what's happening. Two tabs, two jobs, both complete.

---

## The Jobs Test Applied

> "Design is not just what it looks like and feels like. Design is how it works."

The Relay Panel _looks_ cleaner after the redesign. But it doesn't _work_ — you can't manage bindings, the health bar lies about what clicking will show, and the activity feed contradicts the health bar.

Ship would have been rejected. Go back and make it work.
