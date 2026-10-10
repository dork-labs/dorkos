---
id: 261010-143210
title: The first run is account-first, skippable, and lands in #team with a server-posted DorkBot welcome
status: accepted
created: 2026-10-10
spec: one-minute-onboarding
superseded-by: null
amends: [260722-111314]
---

# 261010-143210. The first run is account-first, skippable, and lands in #team with a server-posted DorkBot welcome

## Status

Accepted (operator decisions 2026-10-07; Linear DOR-2783). Spec: `specs/one-minute-onboarding/`.

**Amends:** [260722-111314](260722-111314-onboarding-is-a-scripted-dorkbot-conversation.md). The welcome stays scripted and token-free, but it moves out of the client overlay into a real #team message, and the name, personality, profile and discovery beats leave the first run.

**Supersedes** decision D4 of `specs/dorkos-account-by-default/01-ideation.md` ("credits only as a peer option in the connect step; no sign-in step").

## Context

A person with no outside AI account could not get a reply: the first run led with runtime names, offered credits only inside one runtime's card, and took 4 to 8 minutes. The operator decided that DorkOS's own account, Cloud and engine come first, that the account can be skipped, that a card is required with no starter credits, and that paid plans are US-only at launch, so bringing your own AI is a launch path too.

## Decision

The overlay has three screens: Welcome (Continue with DorkOS, Use my own AI, Continue without an account), a Connecting wait that advances on its own when credits are ready, and an Own AI list that puts DorkOS's engine with a key or local model first and the AI apps second. Choosing a path is the person's pick: the server sets the DorkOS engine as the default runtime and moves DorkBot onto it only then, so existing installs never change. Landing posts DorkBot's welcome into #team through the room service, once, and the client draws suggestion chips under it until the person posts. The power step leaves the first run.

## Consequences

### Positive

- One browser visit on the default path; under a minute from Welcome to #team.
- The first-run history is a real room message, visible on every device.
- No schema-default flip, so upgrades keep their runtime and payer.

### Negative

- The default path depends on Cloud building the sign-in-plus-card approval page and no first-spend hold.
- The scripted beats, their widgets and their browser coverage are deleted; personality and discovery need a later home.
- Chips are client-only and keyed on one stored entry id.
