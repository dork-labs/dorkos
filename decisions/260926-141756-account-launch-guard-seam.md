---
id: 260926-141756
title: Account routing policy belongs to an extension; core only asks its account advisor
status: draft
created: 2026-09-26
spec: claude-account-fleet
superseded-by: null
---

# 260926-141756. Account routing policy belongs to an extension; core only asks its account advisor

## Status

Draft (auto-extracted from spec: claude-account-fleet)

## Context

The operator decided that routing policy (rotation, reserve, repo scope, handoff) is flow's, stored in flow's own file. Core still starts sessions on accounts an agent or a relay message names, and a client's org account must not be spent on unrelated work.

## Decision

- Core never reads flow's policy file.
- The extension server API gains `claudeAccounts.registerAdvisor`: one advisor (last registration wins, with a warning) with `rank`, optional `onLimited` and optional `carryOver`. Core requires its ranking when an AGENT (`session_start`) or a RELAY message names an account (fail-closed on a throw or a 2 s timeout), and uses it optionally to steer the core out-of-usage flow (ranking, automatic handoff, handoff seed).
- A person's own pick is never refused by it; without an advisor every person-facing flow uses core defaults. With no advisor registered, an agent's or a relay message's account pick is refused: nothing is spent until the operator opts in.

## Consequences

- Positive: policy lives in one place, flow; core stays generic.
- Negative: without the Flow extension, agents cannot name an account at all (they still get the default ladder).
