---
id: 260926-141756
title: Account routing policy belongs to an extension; core only asks its account advisor
status: accepted
created: 2026-09-26
spec: claude-account-fleet
superseded-by: null
---

# 260926-141756. Account routing policy belongs to an extension; core only asks its account advisor

## Status

Accepted. Implemented: `accounts.registerAdvisor` in `packages/extension-api/src/server-extension-api.ts`, wired by `apps/server/src/services/extensions/extension-server-api-factory.ts` and consulted through `apps/server/src/services/core/usage/account-advisor.ts` (relay picks gate in `services/relay/turn-execution-settings.ts`).

## Context

The operator decided that routing policy (rotation, reserve, repo scope, handoff) is flow's, stored in flow's own file. Core still starts sessions on accounts an agent or a relay message names, and a client's org account must not be spent on unrelated work.

## Decision

- Core never reads flow's policy file.
- The extension server API gains `accounts.registerAdvisor`: one advisor (last registration wins, with a warning) with `rank`, optional `onLimited` and optional `carryOver`. Core requires its ranking when an AGENT (`session_start`) or a RELAY message names an account (fail-closed on a throw or a 2 s timeout), and uses it optionally to steer the core out-of-usage flow (ranking, automatic handoff, handoff seed).
- A person's own pick is never refused by it; without an advisor every person-facing flow uses core defaults. With no advisor registered, a relay message's account pick is refused, and an agent's pick follows core's own opt-in rule (amended by DOR-5033, 2026-11-23): only an account a person let agents pick (the registry row's `agentsMayPick`, Settings' "Agents may pick this account", default off), and never the main sign-in (by id or by folder), DorkOS credits, an account kept off agents (`noAutoMove`), or one DorkOS could not pick on its own now. Nothing is spent until the operator opts in, account by account, and core reads no file of flow's to decide it.

## Consequences

- Positive: policy lives in one place, flow; core stays generic.
- Negative: without the Flow extension, agents could not name an account at all, only the default ladder. Since DOR-5033 they can name an account a person opened to them in Settings; the two opt-ins are separate, so an account Flow lets agents use is not opened in core's rule, and the reverse.
