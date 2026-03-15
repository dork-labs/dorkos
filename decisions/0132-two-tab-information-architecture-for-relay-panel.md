---
number: 132
title: Two-Tab Information Architecture for Relay Panel
status: draft
created: 2026-03-15
spec: relay-panel-redesign
superseded-by: null
---

# 132. Two-Tab Information Architecture for Relay Panel

## Status

Draft (auto-extracted from spec: relay-panel-redesign)

## Context

The Relay Panel had four tabs — Activity, Endpoints, Bindings, Adapters — mapping directly to internal system architecture concepts. Both a Jobs/Ive design critique and an independent bindings code review concluded that this structure forces users to navigate four tabs to answer what they think of as two questions: "what are my connections?" and "what is happening?" Bindings appeared across six redundant UI surfaces (standalone tab, inline in AdapterCard, BindingDialog, ConversationRow quick-route, sidebar Connections view, wizard bind step) without adding value at each location. Endpoints are an implementation detail (system-generated NATS-like subject subscriptions) that users never need to manage directly.

## Decision

Collapse the Relay Panel from four tabs to two: Connections (adapters with inline bindings, plus the adapter catalog) and Activity (message flow with failure insights). Remove the standalone Bindings tab and the Endpoints tab entirely, deleting `BindingList.tsx`, `EndpointList.tsx`, and `InboxView.tsx`. Extract the existing AdaptersTab inner function to a standalone `ConnectionsTab.tsx`. Change the default tab from `activity` to `connections` — connections are the primary configuration surface a first-time user needs to see.

## Consequences

### Positive

- Matches the user's mental model: two concepts, two tabs.
- Eliminates three redundant components (`BindingList`, `EndpointList`, `InboxView`) and the associated dead code paths.
- Reduces navigation cost for common tasks — Kai no longer crosses four tabs to answer one question.
- Inline binding management in AdapterCard remains, keeping bindings in context of their adapter.

### Negative

- Loses the standalone binding flat-list view, which provided a global overview of all bindings across all adapters in one place.
- Users who want visibility into registered endpoint subject patterns lose that surface entirely (endpoints are now implicit in adapter + binding configuration).
