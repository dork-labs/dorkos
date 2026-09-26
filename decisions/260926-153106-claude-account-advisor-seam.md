---
id: 260926-153106
title: An extension advises which Claude accounts a person is offered and moves the work it runs; core never reads its policy
status: draft
created: 2026-09-26
spec: claude-account-ui
superseded-by: null
---

# 260926-153106. An extension advises which Claude accounts a person is offered and moves the work it runs; core never reads its policy

## Status

Draft (auto-extracted from spec: claude-account-ui)

## Context

The "Continue on another account" picker has to show flow's policy (a reserved main account, a client account kept out of this repo) and, for a session a flow run owns, move the work through flow so its run record follows. ADR 260926-141756 keeps flow's policy file out of core, and the launch guards it adds answer only yes or no for agent and relay launches.

## Decision

- The extension server API gains `claudeAccounts.registerAdvisor({ describe, advise, continueSession? })`, one advisor at a time.
- Core asks it when building continue options and when a person continues a session: annotations shape what is offered; `continueSession` moves a session the advisor manages.
- A managed move that fails is shown to the person and never retried as a core launch. With no advisor, core offers every account and ranks by room left.
- A person's pick is still never run through the launch guards.

## Consequences

- Positive: core stays generic and never reads flow's file; flow's records stay right when a person moves a flow run.
- Negative: a second seam beside the launch guards; an advisor that is slow degrades to no advice (2 s cap).
