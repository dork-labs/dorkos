---
id: 260722-111315
title: Discovery scans run only after explicit user consent
status: proposed
created: 2026-07-22
spec: dorkbot-is-the-onboarding
superseded-by: null
---

# 260722-111315. Discovery scans run only after explicit user consent

## Status

Proposed

## Context

The onboarding filesystem discovery scan was prefetched the moment the user reached the personality step, trading privacy posture for latency: the machine was scanned before the user was asked. The conversational onboarding (ADR 260722-111314) turns discovery into a dialogue beat, which makes the mismatch visible: DorkBot would be asking "want me to look around?" after already having looked. The alternative was keeping the prefetch for its snappier results.

## Decision

We will start the discovery scan only after the user explicitly consents in the conversation ("Sure, look around"), and remove the prefetch. The scan keeps its existing 8-second onboarding budget with an honest timeout line, and the shared discovery store still retains late results for the mesh panel. Decline is respected: no scan runs.

## Consequences

### Positive

- The consent question is true when asked; the scan is an answer to it, not a formality. This matches the be-honest-by-design decision filter and Lil/Priya's privacy expectations.
- Zero-result and timeout cases get honest, visible copy instead of a silent skip.

### Negative

- Consenting users wait for the scan where the prefetch previously hid the latency (bounded by the existing 8s budget; typical scans resolve in milliseconds).
