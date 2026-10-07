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

The reset's other decisions are recorded where they replace an older ADR: 261006-225605 (trusted by default), 261006-235238 (one server), 261006-235239 (equal accounts), 261006-235240 (one message system), 261006-235241 (shared docs), 261006-235242 (one package type). Parts of the vision with nothing to replace yet get an ADR when they are specified: an agent's own computer, the vault, email and phone as account features, the CLI/SDK/GraphQL surface, groups, projects, tasks and goals with the health check, and publishing.

## Context

The July plan ran positioning in two acts. Act 1 sold DorkOS to developers as "one place for every AI agent you run", led by Claude Code, Codex and OpenCode side by side. Act 2, for business users, waited on three business-facing Shapes, a non-developer cohort and a frictionless install. In October the operator reset the vision: the people who get the most from DorkOS are founders who build a business mostly with agents, and the product they need is a shared workspace, not a better agent window.

## Decision

We will describe and build DorkOS as **a workspace for people and agents**: Slack-like DMs, group DMs, channels, threads and shared docs, with agents as co-workers rather than assistants. The primary persona is **the founder** (semi-technical, strong vision, builds a big business mostly with agents; the rewrite of Ikechi), the secondary is **Kai**, and Priya and Lil retire. The tagline stays "You, Multiplied.", and "Claude Code, Codex and OpenCode side by side" moves from the story into the docs. There is no second act and no evidence gate. The demo-claim gate (`meta/positioning-202607/09-gtm-plan.md` §2.0) still applies: copy describes only what ships, and unbuilt parts stay behind experimental switches.

## Consequences

### Positive

- One story from launch, aimed at the people who get the most from the product.

### Negative

- Copy across `meta/`, the site, the README and docs has to be rewritten (DOR-2736), and the 2026-07 positioning corpus becomes history.
- The product leads with business users before most of the business-facing pieces (equal accounts, built-in email, the vault) exist, so the demo-claim gate carries more weight.
