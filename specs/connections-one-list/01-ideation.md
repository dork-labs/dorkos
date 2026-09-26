---
slug: connections-one-list
title: Connections, one list
created: 2026-09-26
status: ideation
design-session: .dork/visual-companion/41903-1790444717
linear: DOR-2418
---

# Connections, one list

## The problem

`/connections` stacks six sections — Communities, live chat bots, "Add a way to reach them", message-delivery settings, Accounts, agent requests — with the Composio/Nango keys at the very bottom. A person has to learn Messaging vs Accounts vs Communities, managed vs their own key, and Composio vs Nango before connecting anything. Its search promises Gmail and answers "No matching services" whenever no connection service is set up, without saying why. And the one path people actually take — an agent needing an app mid-chat — ends on this page instead of in the chat.

## The direction

One plain list of apps. Two ways in: from a chat (the main one), and from the page for planning ahead. Both end with the app connected, the right agents able to use it, and the person already using it. Plumbing moves to Settings; Communities move to the sidebar switcher designed for them.

Every decision, with the mockups and the reasoning, is in [design-decisions.md](./design-decisions.md). The work items and their order are at the end of that file.

## Prior work

- `research/20260729_connections-ux-critique.md` — the earlier critique; its "invert around the catalog", "chat is the front door" and "try-it-now" points carry through.
- `specs/white-label-connections/` — the grant model, agent requests and resume-on-decision this design builds on.
- `specs/community-switcher-navigation/` — the Communities home (§10 of the design record).
- ADR `260804-021140` — the two-region page this design supersedes (ADR owed with DOR-2418).
