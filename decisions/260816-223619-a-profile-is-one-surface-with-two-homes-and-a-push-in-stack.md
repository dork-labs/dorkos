---
id: 260816-223619
title: A profile is one surface with two homes and a push-in stack
status: accepted
created: 2026-08-16
spec: profile-unification
amends: 260806-222547
superseded-by: null
---

# 260816-223619. A profile is one surface with two homes and a push-in stack

## Status

Accepted (2026-08-16) — implemented across the profile-unification programme (DOR-1248; PRs #1049, #1051, #1052, #1055, #1058, #1059, #1063). Amends 260806-222547: the "drawer to view, settings to edit" split is retired for editing (your own rows are the controls; Settings › Profile stays as a second door) and the "drawer" becomes one Profile with two homes; the `?profile=<id>` address, the one-component-for-every-kind rule, `ResponsiveSheet`, and the hover card's `onViewProfile` prop all still govern.

## Context

By 2026-08 the cockpit had two things both called "profile" for the same agent: a bare identity drawer (face, handle, three chips, "Joined") opened from Team cards and mention pills, and an "Agent Profile" right-panel tab that was really a settings workbench (the Agent Hub: Sessions · Config · Toolkit) with a permanently "Offline" status. They shared no header, no key, no status words, and no link to each other; users had to learn "View profile" and "Manage" as separate verbs. The hub itself packed four navigation systems into one panel. Dorian's brief: one intuitive surface, dramatically simpler, and the word "hub" retired.

## Decision

We will ship **one `Profile`** component (`features/profile`) keyed by the roster member id, with **two homes**: docked as the right-panel tab **Profile** on `/session` (default tab; `inOwnSession`, so no Message button) and a right sheet everywhere else, still addressed by `?profile=<id>` (+ `?profilePage=<page>`); on `/session` a link to the current session's agent docks instead of sheeting. The **header is a Portrait** in a fixed order — face, name + badges, @handle, one status sentence from the live activity signal, who it belongs to (owner face + "Managed by …", or "System agent"), and one Message button that renders only when it has a target. The **body is a property list** (rows grouped by spacing, no labels, no inner tabs); if you manage the identity **the row is the control** — `pick ▾` opens a popover, `› ` pushes a **full-height page** whose only fixed chrome is "‹ Profile" + a small identity strip, `⧉` copies, `🔒` stays visible with its reason. Managed-agent pages and popovers carry everything the hub had (sessions, tasks, rooms, skills, tools & MCP, connections, instructions, boundaries, appearance, runs-on, personality) plus a kebab for the rare actions; people get a **Manages** row (face stack); DorkBot's identity is locked but its personality and model are yours. Chained profiles (owner ↔ managed agent) live on the same stack with a visible way back in both homes. Legacy `?panel=agent-hub` / `hubTab=` links redirect once. A `?profile=`/`?panel=profile` **link outranks the persisted per-agent layout** for exactly the arrival bind (a one-bind shield spent by the next bind for anyone else), so a link never opens nothing and never leaks into later agent switches. `features/agent-hub` is deleted; "hub" leaves copy and code; the one visible verb is **View profile** (accessible labels stay "Open {name}’s profile").

## Consequences

### Positive

- One word, one component, one mental model for every identity kind — Slack's model; the Team card, the sidebar face, a mention pill and the session panel all land in the same place.
- Progressive disclosure by construction: the root answers who/whose/alive/how-to-reach; everything else is one row away and takes the whole panel when opened.
- Editing in place makes the profile honest ("Saved" only after the server stored it; a refused save keeps your text) and removed a live data-loss bug in `PATCH /api/agents/current` on the way.
- Deep links are truthful: they open a visible panel on the page they name, on the agent they name, and stop applying once you move on.

### Negative

- The right-panel deep-link precedence rules (shield, spend, release, per-agent applied-set) took five review rounds to get right and are the most intricate state in the client; a future writer who closes the panel _for_ the user must not answer a pending link.
- Settings › Profile now duplicates the self rows (kept deliberately as a second door; D8).
- The injected-prompt preview is re-implemented client-side to follow the draft; nothing yet asserts it agrees with `agent-context.ts` (follow-up filed).
- Someone else's agent shows only about / runs on / rooms — the spec's richer promise needs data no other person's agent has locally.
