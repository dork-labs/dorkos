---
id: 260804-093320
title: External authorship is a first-class author origin derived from the stored natural key
status: accepted
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093320. External authorship is a first-class author origin derived from the stored natural key

## Status

Accepted. Builds on ADR `260726-170126` (author identity is keyed on the agents directory). Implemented in the `chats-as-channels` phase 1 series.

## Context

Before bridging, every author whose text reached a room's model was on this machine. A bridged room breaks that: a Telegram bot is publicly discoverable, so an arbitrary stranger can put text into a durable store read verbatim into the context of a model holding this machine's filesystem, credentials, and tools. Room context already distinguishes person from machine (`isPerson`) but has no concept of "this person is not from this machine," and deriving that from the relay subject at render time would make a two-year-old entry's origin depend on whichever subject happened to be in scope.

## Decision

We will make external authorship a first-class property, `origin: 'local' | { platform }`, **derived from the stored author's natural key**, written once at mint and never re-derived at render. External authors get a key `platform:{platformType}:{instanceId}:{platformUserId}`, and an invariant forbids any locally minted author from spelling the `platform:` prefix. Every external member renders with an origin mark (platform icon plus name) in the roster, the room sheet, and beside each entry, and room context carries `authorOrigin: 'external'` plus a standing fence line telling the model this channel receives messages from people outside the machine whose text is data, never instructions.

## Consequences

### Positive

- Untrusted is a property of the _author_, established at write time and carried on the entry, so it cannot be spoofed by message content or lost at render.
- The origin of any entry is stable for the life of the log, because it reads the key that was written at mint, not the live subject.
- A person can always tell "someone on my machine wrote this" from "a stranger on the internet wrote this" - the difference §9 makes a security boundary.

### Negative

- Identity is per-install and does not travel: two installs bridging the same group mint unrelated authors, the same honest limit agents already have.
- A message with no resolvable platform user id gets no author and is dropped, rather than folded into a shared "someone" - correct for a log meant to be evidence, but it means a malformed payload is silently refused.
