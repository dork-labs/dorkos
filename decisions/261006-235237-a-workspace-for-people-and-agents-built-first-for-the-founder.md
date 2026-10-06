---
id: 261006-235237
title: DorkOS is a workspace for people and agents, built first for the founder
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
supersedes: 260718-042153
---

# 261006-235237. DorkOS is a workspace for people and agents, built first for the founder

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735, docs rewrite DOR-2736).

**Supersedes** [260718-042153](260718-042153-two-act-positioning-gated-business-user-act-2.md) whole. That ADR launched on developer framing and held business users back until three evidence triggers fired. The 2026-10 reset drops the gate: business users lead from launch.

## Context

The July plan ran positioning in two acts. Act 1 sold DorkOS to developers as "one place for every AI agent you run", led by Claude Code, Codex and OpenCode side by side. Act 2, for business users, waited on three business-facing Shapes, a non-developer cohort and a frictionless install. In October the operator reset the vision: the people who get the most from DorkOS are founders who build a business mostly with agents, and the product they need is a shared workspace, not a better agent window.

## Decision

We will describe and build DorkOS as **a workspace for people and agents**: Slack-like DMs, group DMs, channels, threads and shared docs, where agents are co-workers rather than assistants. The primary persona is **the founder** (semi-technical, strong vision, runs a big business mostly with agents; the rewrite of Ikechi). The secondary persona is **Kai**, the developer running many agents across many projects. Priya and Lil retire as personas. The tagline stays "You, Multiplied."; "runtimes side by side" moves out of the story and into the docs. There is no second act and no evidence gate. Everything the new story names still passes the demo-claim gate (`meta/positioning-202607/09-gtm-plan.md` §2.0): copy describes only what ships, and unbuilt parts stay behind experimental switches.

## Consequences

### Positive

- One story from launch, aimed at the people who get the most from the product.
- Features are judged by one question: does this help a founder run the business from one place?

### Negative

- Copy across `meta/`, the site, the README and docs has to be rewritten (DOR-2736), and the 2026-07 positioning corpus becomes history.
- The product leads with business users before most of the business-facing pieces (equal accounts, built-in email, the vault) exist, so the demo-claim gate carries more weight.
