---
number: 122
title: Layered Documentation System for Adapter Setup
status: proposed
created: 2026-03-14
spec: adapter-setup-experience
superseded-by: null
---

# 0122. Layered Documentation System for Adapter Setup

## Status

Proposed

## Context

Complex adapters like Slack require multi-step guidance across multiple external service pages, with critical pitfalls (e.g., "Agents & AI Apps" adding invalid scopes). A single info box is insufficient. Research across VS Code walkthroughs, Home Assistant, n8n, and other plugin systems identified progressive disclosure as the dominant pattern — users get brief context by default and expand for detail on demand.

## Decision

Implement three complementary documentation layers in the adapter setup wizard: (1) `setupInstructions` rendered as markdown in the existing info box (always visible, brief summary), (2) `helpMarkdown` per ConfigField rendered as a collapsible "Where do I find this?" disclosure (on-demand, field-specific), and (3) `setupGuide` rendered in a slide-out Sheet panel (on-demand, full walkthrough). Each layer serves a different moment: scanning, stuck-on-a-field, and lost-in-the-process.

## Consequences

### Positive

- Progressive disclosure — experts skip help, beginners find it where they need it
- Each documentation layer serves a distinct user need at a distinct moment
- Backward compatible — all new fields are optional, existing adapters work unchanged
- Pattern scales to any adapter complexity level

### Negative

- Three documentation surfaces to maintain per adapter
- Adds visual density to the form when multiple fields have help disclosures
- Requires careful UX design for the collapsed/expanded states
