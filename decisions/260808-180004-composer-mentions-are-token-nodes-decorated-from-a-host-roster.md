---
id: 260808-180004
title: Composer mentions are token text nodes decorated from a host-supplied roster
status: draft
created: 2026-08-08
spec: composer-rich-text
superseded-by: null
---

# 260808-180004. Composer mentions are token text nodes decorated from a host-supplied roster

## Status

Draft (auto-extracted from spec: composer-rich-text)

## Context

The 2026-08-06 design session locked full WYSIWYG for mentions: after the `@` picker resolves, the composer shows the same identity-coloured `MentionPill` the sent message shows, and it behaves as one atomic unit — backspace deletes the whole pill. Two constraints bound how that can be built. Addressing stays server-side write-time resolution (`.claude/rules/room-conduct.md`); the editor may never become the resolver. And the composer's host contract is a markdown string (ADR 260808-180001), so whatever a mention is in the document must serialize to `@handle` and parse back from it without drift, or a restored draft loses every pill and the round-trip invariant fails.

## Decision

A mention is a `TextNode` subclass in token mode, not a decorator node. Token mode is what makes it atomic — the caret cannot enter it and backspace removes it whole — and its text _is_ `@handle`, so it serializes through the ordinary text path with no transformer and round-trips for free. Its `createDOM` emits the same span `MentionPill` emits, so a change to how a mention looks in a message changes how it looks in the composer once. Nodes are materialized by a single node transform that promotes any plain `@handle` matching the trigger shape when the handle appears in a roster the **host** supplies through one additive optional prop; the picker's insert and a hand-typed handle therefore converge on the same node. A handle absent from the roster stays plain text. Surfaces with no roster (chat, dashboard, onboarding) pass nothing and get no pills.

## Consequences

### Positive

- A hand-typed mention and a picked mention look identical, which is honest: the server resolves both the same way at write time, so showing them differently would misdescribe what is about to happen.
- Draft restore, queue-item edit, and `?prompt=` seeding all recover their pills, because the pill is derived from text plus roster rather than stored alongside it.
- No React portal per mention, no decorator sizing, no selection special-casing, and no new serialization rule.

### Negative

- The composer gains a new optional prop, so the "same props" promise DOR-946 made is kept only in the additive sense; every existing call site compiles untouched, but the surface is wider than it was.
- The transform runs over text on every relevant update; a large roster needs the match kept cheap.
- Pills are presentation only and can disagree with what the server ultimately resolves (a handle the client's roster is stale about). The pill must never be read as confirmation that a mention landed — the entry the server stored is still the only thing that says so.
