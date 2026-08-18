---
id: 260818-002805
title: One Conversation compound, with capability flags instead of surface switches
status: draft
created: 2026-08-18
spec: unified-conversation
superseded-by: null
---

# 260818-002805. One Conversation compound, with capability flags instead of surface switches

## Status

Draft (auto-extracted from spec: unified-conversation)

## Context

DorkOS draws a conversation three times — the agent session, a channel, and a direct message — and a DM is already a channel whose `kind` changes only its naming. So there are two implementations for three presentations, and they duplicate nine things: the row, the list, the composer host, the hover actions, the markdown path, the scroll pinning, the time formatter, and two separate vocabularies for "someone is working" and "someone needs you". The seams for sharing already exist and are half-used: `Composer.*` is a namespace compound both hosts build on, `buildTimelineRows` is surface-neutral, and `messageItem` is a multi-slot `tailwind-variants` with an `anchor: corner | rail` variant that was written for exactly this merge — but has one consumer, so rooms style their rows by hand. Every attempt to share more has stalled on the same question: where does the shared code live, given that a feature's model may never import a sibling feature's model?

## Decision

We will build one `Conversation` namespace compound — `Root · Header · Timeline · LiveLane · Composer · Footer`, with a `Message.*` row family — in a **new `features/conversation` slice**, and have both host widgets compose it. Look is decided by `tailwind-variants` (`surface`, `anchor`, `density`); content by a body-renderer map each host supplies, so session parts and room bodies stay typed at their own end and are never forced into one union; and behaviour by a **`ConversationCapabilities` object each host declares as a module constant** (reactions, threads, run-with, attachments, tool cards, mentions, presence, turn status, asks). No component below `Conversation.Root` may branch on `surface`, and a source-scan test enforces it. A new slice rather than a grown `features/chat` because `features/chat` carries a large session-specific model; a shared tree there would force room-side hooks into feature-model cross-imports, which the layer rule forbids outright.

## Consequences

### Positive

- A change to the row, the list or the composer happens once and is visible on all three surfaces, including in one Dev Playground section that renders them side by side from one fixture set.
- Giving a session reactions, or a room tool cards, moves one boolean in one table and touches no component.
- The layer rule is satisfied by construction: the slice depends only on `entities/*` and `shared/*`, and the two hosts are widgets, which may import features in either direction.
- The room timeline gains virtualization and the scroll thumb; the session timeline gains thread grouping and a pending list. Neither had to be written twice.
- Roughly 2,900 lines of duplicated component code are deleted, each in the same pull request that replaces it.

### Negative

- The capability table is a new place to be wrong, and a missing flag reads as a missing feature rather than as an error. Only the playground's capability matrix makes that visible.
- `payload: unknown` on a message row is deliberately untyped at the timeline boundary, so a host that hands the wrong payload to the wrong renderer fails at runtime rather than at compile time.
- A four-pull-request migration means both vocabularies coexist on `main` for the length of the train, and every phase has to leave the tree shippable.
- Merging two scroll hooks means adopting the room's stick-to-bottom semantics wholesale, including behaviour the session never had; the room's tuned thresholds win every disagreement, which is a choice the session's users will feel.
- `features/conversation` will be a large slice. It is one concept, but it is not a small one.
