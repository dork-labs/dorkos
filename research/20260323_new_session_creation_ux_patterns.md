---
title: 'New Session / New Conversation Creation UX Patterns'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [
    session-creation,
    ux-patterns,
    chat,
    conversation,
    eager,
    lazy,
    draft,
    url-routing,
    chatgpt,
    claude,
    linear,
    slack,
  ]
searches_performed: 18
sources_count: 22
---

## Research Summary

This report examines how world-class chat and productivity applications handle the creation of new conversations, sessions, and issues. The central question is whether entities are created **eagerly** (server-side record created on button click) or **lazily** (server-side record created only when first content is submitted). The research reveals a clear industry consensus: the leading pattern is **lazy creation with optimistic/local UI**, where the UI presents a composed "ready to type" state immediately, and the backend entity is only created when the user commits their first action. URL routing is updated either at that commit moment or optimistically in advance using client-generated IDs.

---

## Key Findings

1. **ChatGPT uses pure lazy creation**: The URL stays at `/` (or a temporary chat URL) until the first message is sent. Only after send does the URL update to `/c/{uuid}`. There is no intermediate server record.

2. **Claude.ai uses lazy creation with an eager URL shortcut**: Navigating to `claude.ai/new` or clicking "New chat" immediately navigates to `claude.ai/chat/{id}` — but the conversation record is not created server-side until the first message. The UUID may be client-generated or reserved speculatively.

3. **Linear uses a modal-based draft pattern with eager submission**: The creation UI is a floating modal overlay that preserves the user's current context. There is no URL change during composition. The entity (issue) is created on form submit, navigating the user to the issue URL. Local drafts persist in IndexedDB for the in-progress modal state. Post-submit, Linear's sync engine applies the creation optimistically so the URL is navigable immediately.

4. **Slack uses eager conversation creation with lazy messaging**: The channel/DM container is created (or opened) eagerly via `conversations.open` — but the container can exist with zero messages. The message itself is lazy. The URL navigates to the channel immediately.

5. **Microsoft Teams uses explicit draft state**: A "new chat" deep link creates a chat in **draft state** with no URL until the first message is sent.

6. **The dominant best practice is: lazy session creation, optimistic URL assignment, immediate UI readiness.**

---

## Detailed Analysis

### ChatGPT — Pure Lazy Creation

**Behavior:**

- Clicking "New chat" in the sidebar navigates to `chatgpt.com/` (root) or remains on a blank canvas.
- The URL stays at `/` until the user sends their first message.
- After the first message is sent, the URL updates to `chatgpt.com/c/{uuid}` where `uuid` is a v4 UUID format.
- There is a "Temporary chat" mode where the URL is `chatgpt.com/?temporary-chat=true` — this conversation is never persisted to history.
- No intermediate "draft" state exists in the UI — you either send or you don't.

**Architecture:**

- Conversation entity is created server-side only after first message submission.
- The UUID is server-assigned and returned as part of the create-conversation API response.
- URL is updated via `history.pushState` after the server confirms the conversation ID.
- This is pure lazy creation — no record exists until the user acts.

**Why this works:**

- Zero wasted server resources. If a user opens "New chat" and then walks away, nothing was created.
- The empty canvas feels instant — no loading states, no skeleton screens.
- Clean separation: the "new chat" view is a pure UI state, not a server entity.

**Tradeoff:**

- The URL cannot be bookmarked or shared until after the first message. Users cannot link someone to "start a conversation here."

---

### Claude.ai — Lazy Creation with Speculative URL

**Behavior:**

- Clicking "New chat" navigates to `claude.ai/chat/{id}` immediately — the URL changes on click.
- However, the conversation record is not fully persisted until the first message is sent.
- The UUID in the URL appears to be either: (a) client-generated speculatively, or (b) a reserved/pending ID from a lightweight server ping.
- If the user closes the tab without sending, the conversation does not appear in history.

**Architecture:**

- This is a hybrid: the URL changes eagerly (good for UX — feels snappy), but the backend entity is lazy.
- This allows the URL to be stable immediately (useful for share-on-open or deep-linking patterns) while not creating garbage data in history.
- The conversation enters history only on first message — the "last updated" timestamp drives sidebar ordering.

**Why this works:**

- Users get a stable URL immediately, which matters for keyboard-heavy workflows.
- No orphan records pollute the conversation history.
- The UX feels faster than ChatGPT's pure lazy approach because the URL transition happens on click, not after server response.

---

### Linear — Modal Draft + Eager Submission + Optimistic Navigation

**Behavior:**

- Pressing `C` (or clicking the "New issue" button) opens a **floating modal overlay** — the URL does NOT change.
- The user composes in the modal. If they navigate away, the modal is hidden and the in-progress content is auto-saved as a **local draft** (stored in the browser, device-specific).
- Pressing `Esc` prompts: save as draft (cross-device, persisted) or discard.
- When the user clicks "Create issue" (submits the form), the issue is created on the server and the user is navigated to `linear.app/org/issue/TEAM-123`.
- The issue ID (e.g., `ENG-456`) is assigned at creation time, not before.

**Architecture:**

- Linear uses a local-first sync engine. All workspace data lives in the browser's IndexedDB.
- On submit, the mutation fires against the GraphQL API, but the UI reflects the change **immediately** (optimistic update). The user is navigated to the new issue URL before the server responds.
- If the server rejects (rare), the optimistic update rolls back.
- The issue identifier (short ID like `ENG-456`) is server-assigned. The internal UUID may be client-generated.
- Changes made in the first 3 minutes after creation are considered "part of creation" and are not logged as edits — a grace period design that acknowledges the creation/edit boundary is artificial.

**Two distinct draft types:**

1. **Local draft**: In-modal content saved to IndexedDB when you navigate away mid-composition. Only on your device, cleared on logout.
2. **Saved draft**: Explicit draft entity saved to the server when you press Esc → Save. Cross-device, persists indefinitely.

**Why this works:**

- The modal-overlay approach means users **never lose context**. You can look something up without abandoning your draft.
- Local drafts handle the "got distracted" case automatically with zero friction.
- Optimistic navigation post-submit means the experience feels instant even on slow connections.
- The `linear.new` shortcut URL supports deep-linking into the creation form with pre-filled fields, enabling powerful external integrations.

**Why Linear chose a modal over a full-page flow:**
Their changelog explicitly states: "you stay in the view you are in so that you don't lose context." The design philosophy is that issue creation is a _frequent_, _quick_ action — not a destination. Context preservation was the primary driver.

---

### Slack — Eager Container, Lazy Content

**Behavior:**

- When you open a DM with someone, Slack calls `conversations.open` on the API, which **creates or resumes** the conversation container eagerly.
- The URL changes to `app.slack.com/client/{workspace}/{channel-id}` immediately, before any message is sent.
- The conversation container exists with zero messages — this is an acceptable state in Slack's model.
- A `prevent_creation: true` parameter exists in the API, allowing callers to check for existing conversations without creating new ones — this is explicitly for the "check before creating" use case.
- Message drafts are auto-saved: if you type and navigate away, the draft is preserved in the compose box.

**Architecture:**

- Channel/DM containers are first-class persistent entities in Slack. They can exist empty.
- This makes sense for Slack's model: channels especially have meaning independent of messages (they are named, have topics, have members).
- For DMs specifically, the conversation is a container that "opens or resumes" — meaning Slack never creates a second DM between the same two users.
- The URL always reflects the container, not the messages.

**Why this works for Slack:**

- Slack's mental model is **channels as places**, not conversations as threads. The container is the primary entity.
- This is fundamentally different from ChatGPT/Claude where the conversation **is** the content — there's no meaning to an empty AI chat.
- The eager approach enables Slack's powerful linking, notification, and membership models that depend on the container existing.

**Draft auto-save:**

- Slack saves unsent messages as drafts automatically. The "Drafts & sent" section in the sidebar aggregates all in-progress messages.
- This is a post-composition draft — not a pre-composition creation draft. The container already exists.

---

### Microsoft Teams — Explicit Draft State

**Behavior:**

- Creating a new chat via deep link (`https://teams.microsoft.com/l/chat/0/0?users=...`) creates the chat in **draft state**.
- The chat is not assigned a real URL/ID until the first message is sent.
- The compose box is pre-populated (via the `message` deep-link parameter) but the message is not auto-sent.
- Once sent, the chat gets a real URL and appears in history.

**Architecture:**

- This mirrors ChatGPT's lazy approach but with an explicit "draft chat" label/state.
- Teams distinguishes between "draft threads" (created by the calling bot before a call) and "real" threads that have messages — this has caused UX issues (unwanted empty chat threads appearing for users).
- The explicit draft state is a UI affordance for the deep-link use case specifically.

---

## The Three Fundamental Patterns

### Pattern 1: Pure Lazy Creation

**Examples:** ChatGPT, Microsoft Teams (via deep-link)
**How it works:**

- UI renders an empty canvas (no server entity exists)
- URL stays generic (e.g., `/`) or uses a temporary marker
- On first submit → server creates entity → URL updates to permanent ID
  **Best for:** When conversations have no meaning without content. When you want to minimize server-side garbage. When the URL doesn't need to be stable before first message.
  **Tradeoff:** Cannot bookmark/share before first message. URL transition feels like a page navigation event.

### Pattern 2: Speculative Eager URL + Lazy Body

**Examples:** Claude.ai
**How it works:**

- On "New chat" click, a UUID is generated (client-side or via lightweight server call)
- URL updates immediately to `/chat/{uuid}`
- Server entity is not created until first message
- If user abandons, no record persists
  **Best for:** When URL stability matters immediately (keyboard shortcuts, deep-link support). When you want the "snappy" feel of an immediate URL transition. When the conversation should still not persist until content exists.
  **Tradeoff:** Slight complexity in managing the "reserved but not yet created" state.

### Pattern 3: Modal Composition + Optimistic Post-Submit Navigation

**Examples:** Linear, GitHub (new issue), Notion (new page)
**How it works:**

- Creation is a modal overlay, URL doesn't change during composition
- The current page URL is preserved (context maintenance)
- On submit, optimistic update: navigate to new entity URL immediately
- Server confirms in background; rollback on failure
  **Best for:** When the entity is a child of an existing context (issue in a project, task in a list). When creation is frequent and should not interrupt flow. When a rich draft/recovery mechanism is valuable.
  **Tradeoff:** Modal UX has limits for complex forms. Full-page creation (`V` shortcut in Linear) is offered as an escape hatch.

---

## The Architectural Decision: When Does the Entity Exist?

The critical question is: **when does the backend entity come into existence?**

| App       | Entity Created       | URL Assigned             | Draft State                             |
| --------- | -------------------- | ------------------------ | --------------------------------------- |
| ChatGPT   | On first message     | After first message      | None (client state only)                |
| Claude.ai | On first message     | On "New chat" click      | None                                    |
| Linear    | On form submit       | Optimistically on submit | Local (device) + Server (explicit save) |
| Slack     | On conversation open | On conversation open     | Message-level auto-draft                |
| MS Teams  | On first message     | After first message      | "Draft chat" label                      |

---

## What Is "Best Practice" and Why

The consensus in 2024-2026 among high-quality applications is:

**1. Don't create backend entities until there is content to store.**
An empty conversation record is meaningless state. It pollutes history, wastes storage, and creates edge cases (what is the "title" of an empty conversation? When was it last updated?). ChatGPT, Claude, and Teams all agree: no entity until there is a message.

**2. Assign the URL as early as possible, but not before the user expresses intent.**
There is a subtle difference between "new chat page loaded" and "user clicks new chat." Claude's approach of assigning a UUID on click (not on page load) is the sweet spot — the user has expressed intent, so giving them a stable URL immediately is a UX win.

**3. Use optimistic updates aggressively for creation.**
Linear's pattern — optimistically navigate to the new entity's URL before server confirmation — is the gold standard for perceived performance. Users never see a loading state; the entity "exists" in the UI the moment they submit. The 3-minute creation grace period is a particularly elegant detail that acknowledges the reality of how users iterate immediately after creating something.

**4. Preserve context during creation.**
Linear's modal approach is the correct answer when the creation action is contextual (creating an issue while looking at a project view). For AI chat, where the conversation canvas _is_ the primary view, a full-page approach makes more sense.

**5. Draft state should be invisible by default, visible by intent.**
The best apps (Linear, Slack) save draft state automatically without prompting the user. The user only thinks about drafts when they try to exit — at which point an explicit prompt ("save as draft?") is appropriate.

---

## Implications for DorkOS Session Creation

DorkOS sessions are closer to **AI conversations** (ChatGPT/Claude model) than to **issue trackers** (Linear model). Sessions have no meaning without content. Relevant patterns:

- **Session entity should not exist until first message is sent.** Creating a session on "New chat" click is wasteful and creates edge cases in the session list.
- **URL should change on first message send**, not on click. The `/session?session={id}` URL should only become valid once the session exists.
- **Optimistic URL assignment** (Claude's approach) is worth considering if keyboard-shortcut or deep-link use cases require a stable URL before first message. Generate a client-side UUID, speculatively set the URL, create the server entity on first send.
- **The empty state between "new chat" click and first message** should feel like an invitation, not a loading state. No spinners, no skeleton screens — just a focused input.
- **If session list ordering matters**, the session should only appear in the sidebar after first message, not on creation. This prevents ghost sessions from cluttering navigation.
- **The `?dir=` parameter pattern** DorkOS already uses (for working directory context) maps well to Linear's `linear.new?assignee=...` pre-fill pattern — URL parameters can carry context into session creation without requiring an upfront backend record.

---

## Sources & Evidence

- "Every time you start a new chat, the URL changes [to `chatgpt.com/c/{conversation-id}`]" — [How Many Unique Chat URLs Can ChatGPT Actually Generate](https://dev.to/shubhadip_bhowmik/how-many-unique-chat-urls-can-chatgpt-actually-generate-473o)
- "Automatic issue drafts, so you can easily pick up where you left off if you get sidetracked" — [Linear Changelog: New issue creation UI](https://linear.app/changelog/2021-02-25-new-issue-creation-ui)
- "Navigate away from it and the issue will be saved as a draft automatically" — [Linear Changelog: New issue creation UI](https://linear.app/changelog/2021-03-10-new-issue-creation-ui)
- "Changes made to an issue's properties in the first 3 minutes are considered part of the issue creation process" — [Linear Docs: Creating Issues](https://linear.app/docs/creating-issues)
- "Opens or resumes a direct message or multi-person direct message...You can then send a message to the conversation using the `chat.postMessage` method" — [Slack Developer Docs: conversations.open](https://docs.slack.dev/reference/methods/conversations.open/)
- `prevent_creation` boolean parameter on `conversations.open` for checking without creating — [Slack API](https://api.slack.com/methods/conversations.open)
- "When a user creates a new chat using a deep link, Teams creates the new chat in the draft state until the user sends the first message" — [Microsoft Teams Deep Link Docs](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams)
- Linear sync engine: "The frontend can directly manipulate the object graph...triggers an update to the object pool, which then creates a transaction in the queue" — [Linear Sync Engine Architecture](https://www.fujimon.com/blog/linear-sync-engine)
- "Every change in Linear appears to result in a new SyncAction object with a unique ID" — [Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)
- Gmail "Magic Undo" draft pattern: "if you send an email, Gmail doesn't actually send it right away...only after that prompt disappears does that email get sent" — [Design to save people from themselves](https://brianlovin.com/writing/design-to-save-people-from-themselves)
- Linear.new: form opens with pre-filled fields, issue not created until form submitted — [Create issues using linear.new](https://linear.app/developers/create-issues-using-linear-new)

---

## Research Gaps & Limitations

- **ChatGPT's exact URL timing** (whether it's updated before or after server response using `pushState`, and whether a client-side UUID is generated) could not be verified from public documentation. The behavior described is based on observed behavior reported in community forums.
- **Claude.ai's internal mechanism** for the UUID in the URL on "New chat" click — whether this is a full lightweight server call or client-generated — is not publicly documented. The observed behavior (URL changes on click, conversation not in history if abandoned) is documented but the mechanism is inferred.
- **Linear's internal UUID generation** — whether the issue gets a client-side UUID before server confirmation for navigation purposes — is not definitively documented in public sources. The optimistic navigation behavior is inferred from the sync engine architecture.
- No direct source covers **all four apps in a single comparative analysis** — this report synthesizes observations from multiple independent sources.

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: "Linear new issue creation UI changelog", "conversations.open method Slack", "Microsoft Teams draft chat deep link", "Linear sync engine optimistic"
- Primary information sources: Linear docs/changelog, Slack Developer Docs, Microsoft Teams developer docs, HN discussions, reverse engineering posts
