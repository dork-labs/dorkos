---
number: 165
title: Dense List Over Cards for Agent Fleet Display
status: accepted
created: 2026-03-20
spec: agents-page
superseded-by: null
---

# 0165. Dense List Over Cards for Agent Fleet Display

## Status

Accepted

## Context

The Agents page needs a layout pattern for displaying 5-50 registered agents. Three approaches were evaluated: dense list with expandable rows, card grid, and data table. The primary persona (Kai) manages 10-20 agents across 5 projects and needs fast vertical scanning to assess fleet health.

## Decision

Use a dense list with expandable rows (~56px collapsed, ~120px expanded) rather than a card grid or data table. Each row shows health dot, name, runtime badge, project path, session count, capabilities, and last-active timestamp in the collapsed state. Chevron expand reveals full details.

## Consequences

### Positive

- Fast vertical scan speed for named items — users can assess fleet health at a glance
- Progressive disclosure keeps the default view compact while providing full details on demand
- Graceful at any viewport width without breakpoint complexity
- Industry-validated pattern used by Linear, GitHub, Vercel, and Railway

### Negative

- Slightly less visual differentiation between agents compared to cards (mitigated by health dot color and agent emoji/icon)
- Expanded state adds DOM complexity with Collapsible animation
