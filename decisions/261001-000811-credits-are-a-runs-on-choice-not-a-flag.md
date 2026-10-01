---
id: 261001-000811
title: DorkOS credits are a choice in Runs on, never a flag and never a silent switch
status: accepted
created: 2026-10-01
spec: dorkos-account-by-default
superseded-by: null
amends: null
---

# 261001-000811. DorkOS credits are a choice in Runs on, never a flag and never a silent switch

## Status

Accepted (DOR-2623, spec `dorkos-account-by-default` §1, decisions D2, D3 and D7).

It replaces the rule that put DorkOS credits on the repo's money-path table as "a flag beside its own key" (`DORKOS_CLOUD_CREDITS=1` beside the cloud-link credential, DOR-2027). The other six money paths keep that rule unchanged.

## Context

Credits were switched on only by `DORKOS_CLOUD_CREDITS=1`. There was no setting in the app, so a desktop user would have had to relaunch from a terminal. Once on, the credits token was spread last into every Claude Code launch, so it beat the person's own sign-in for every agent: a silent double bill. The token lived only in memory and nothing minted it at startup, so a restart quietly dropped credits; an expired token quietly fell back to whatever sign-in was there. Each of those is somebody paying for something they did not choose.

## Decision

**Who pays for a turn is always a choice a person made, or a default they were told about.** Credits are one more entry, `dorkos-credits`, in a runtime's existing Runs on list. For Claude Code that is the account ladder: a session's own pick, the agent's account, a project rule, then the machine default. There is no new per-runtime field. A credits session runs in a folder DorkOS owns (`<dorkHome>/runtimes/claude-code/credits`), never a registry row, so a resumed conversation stays on whatever paid for it (ADR 260801-204127), and flow's CLI, which reads the same registry, never sees a folder it could launch without the token. The machine default is recorded in `cloud.credits.defaults`, beside the person's own `defaultAccount`, which is left untouched; turning credits off returns to it.

**The choice resolves per session at launch, and fails closed.** A launch whose account is the credits folder gets the endpoint and token or is refused with a plain sentence ("Couldn't reach DorkOS credits · Retry · Use your Claude Code sign-in"). It never runs on anything else. A credits turn also strips the person's own key, OAuth token, custom headers and Bedrock, Vertex and Foundry switches, so it cannot bill any of them. A launch on the person's own sign-in gets no credits variable at all. Automatic steps never move work onto credits: the ladder's fallback skips them, and an advisor's automatic handoff accepts only registered accounts. A person can still pick credits in "Continue on another account".

**Every choice records who made it.** `user` when a person picked it. `default` when a new link found a runtime with no working sign-in and filled that gap; the person is told once, with Change and Undo all, and if that runtime's own sign-in later works, switching back is offered once. A computer linked before this shipped is never armed by migration; it gets one dismissible offer instead.

**The token is kept live, not stored.** The link credential is already kept, so the server mints a token at startup, again before each one expires, and on a new link. A launch that finds none waits for one bounded mint and refuses if it fails.

**`DORKOS_CLOUD_CREDITS` is a kill switch only.** `0`, `false`, `no` or `off` turns credits off for the server: every credits launch refuses, and nothing falls back. Any other value, including the old `1`, changes nothing. It is still read once at module scope and still kept out of every turbo task.

**Credits are a declared runtime capability.** `RuntimeCapabilities.credits` names the protocol a runtime speaks to the endpoint, and absence means no. The host hands a token only to a runtime that declares it, and the wired set every status line reports is derived from those declarations. Only Claude Code declares it today (`anthropic-messages`); Codex and OpenCode join with their own protocols later. `runtimeConformance` holds every runtime to three negatives: no token to a runtime that did not declare credits, a credits turn with no live token refuses and starts nothing, and a turn on the runtime's own sign-in carries no credits token.

## Consequences

### Positive

- No credits turn can ever bill a person's own sign-in or key, and no own-sign-in turn can ever carry a credits token; both are pinned by tests that fail if either rule is broken.
- Credits work after a restart, and an expired token is replaced before a turn finds it.
- A desktop user can choose credits in the app, and is told when DorkOS chose for them.
- Adding credits to another runtime is a declaration plus its protocol's variables, with the conformance negatives already waiting for it.

### Negative

- A session set to credits is refused while this computer is unlinked or credits are switched off. That is the point, but it means one more refusal a person can meet; the card offers their own sign-in in one click.
- A project's own `.claude/settings.json` can still set environment variables the CLI reads after launch. DorkOS strips the routing switches from the process environment but does not rewrite a person's project settings.
- The machine default for credits lives in `cloud.credits`, apart from `runtimes.claudeCode.defaultAccount`, so "what is the default" has two fields to read. The client reads them through one view (`useClaudeAccounts`), and the server through one ladder.
