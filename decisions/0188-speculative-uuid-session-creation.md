---
number: 188
title: Use Speculative UUIDs for New Session Creation
status: draft
created: 2026-03-23
spec: improved-new-session-creation
superseded-by: null
---

# 188. Use Speculative UUIDs for New Session Creation

## Status

Draft (auto-extracted from spec: improved-new-session-creation)

## Context

The "new session" flow used `sessionId === null` to represent both "user wants a new session" and "no session selected, auto-pick one." This overloaded state required a fragile `intentionallyNullRef` guard in `SessionSidebar` to disambiguate the two meanings. A race condition was discovered where unstable callback references caused the auto-select effect to re-fire and override the user's intent. Industry analysis showed that Claude.ai uses a speculative URL pattern where a client-generated ID appears in the URL immediately on "new conversation" click, with lazy server-side creation on first message.

## Decision

Generate a `crypto.randomUUID()` on "New session" click and navigate to `/session?session=<uuid>` immediately. The session never has a null ID on the `/session` route. Auto-selection of the most recent session on page load moves from a component-level `useEffect` to a TanStack Router `loader` that runs before component mount, using `throw redirect()` with `replace: true`.

## Consequences

### Positive

- Eliminates null state ambiguity entirely — no more overloaded semantics
- Removes the fragile `intentionallyNullRef` mechanism
- Flash-free auto-selection via router loader (runs before React mount)
- URL is stable and bookmarkable from the moment of intent
- Simplifies `executeSubmission` in `useChatSession` (removes null→UUID branch)
- Matches Claude.ai's production pattern (validated by industry research)

### Negative

- History query fires for non-existent session UUIDs (returns empty — acceptable, server already handles this)
- If sessions cache is empty on first load, a new UUID is generated even if sessions exist (they load asynchronously and appear in sidebar when ready)
