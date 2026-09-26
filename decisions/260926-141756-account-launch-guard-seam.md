---
id: 260926-141756
title: Account routing policy belongs to an extension; core only asks its launch guards
status: draft
created: 2026-09-26
spec: claude-account-fleet
superseded-by: null
---

# 260926-141756. Account routing policy belongs to an extension; core only asks its launch guards

## Status

Draft (auto-extracted from spec: claude-account-fleet)

## Context

The operator decided that routing policy (rotation, reserve, repo scope, handoff) is flow's, stored in flow's own file. Core still starts sessions on accounts an agent or a relay message names, and a client's org account must not be spent on unrelated work.

## Decision

- Core never reads flow's policy file.
- The extension server API gains `claudeAccounts.registerLaunchGuard`. Core consults every registered guard when an AGENT (`session_start`) or a RELAY message names an account, fail-closed on a throw or a 2 s timeout.
- A person's own pick is never guarded. With no guard registered, any registered account is allowed.

## Consequences

- Positive: policy lives in one place, flow; core stays generic.
- Negative: without the Flow extension, an agent can pick any registered account; the Activity log records every such pick.
