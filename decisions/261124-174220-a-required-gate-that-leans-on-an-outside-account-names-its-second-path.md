---
id: 261124-174220
title: A required gate that leans on one outside account names its second path
status: proposed
created: 2026-11-24
spec: null
superseded-by: null
amends: null
---

# 261124-174220. A required gate that leans on one outside account names its second path

## Status

Proposed by the architect (2026-11-24), from the review of the problems of 2026-11-23 (`research/20261124_architecture-direction-review.md` and Linear DOR-5189 and DOR-5190). Becomes Accepted when the CI owner (ci-steward) agrees and the operator rules on it.

**Builds on** [260919-174348](260919-174348-merges-are-fully-autonomous-machine-gates-are-the-only-gates.md), which stays Accepted, and settles this Negative bullet in it:

> "The review gate draws on the same subscription limits as the agents that write the code, so it needs fail-closed and review-debt rules (phase 2) rather than a simple "required"."

Fail-closed stands. What it adds: a required gate that leans on one outside account must also name a second path that needs no person. The parent's "no human approval before merge, ever" stands, and is the reason a person is not that second path.

## Context

On 2026-11-23 the account behind the cloud Security review hit its weekly limit, and every merge stopped. The required `pr-gates` check (`scripts/pr-gates-check.sh`) passes on one of two sign-offs: the `security-verdict` status that `.github/workflows/security-verdict.yml` posts after the cloud review, or Security's signed review marker, checked against `ci/security/allowed_signers`. The cloud review in `.github/workflows/claude-code-review.yml` runs on one secret, `CLAUDE_CODE_OAUTH_TOKEN`, with no second token and no fallback step. `review-redispatch.yml` asks for the review again up to three times per head, but a weekly limit outlasts every retry. So the only way through was the other sign-off: Security signs each head by hand, and every push voids the signature. Nothing in `ci/gates.yaml` records that a gate leans on an outside account, so the census in `packages/ci-steward` cannot see this kind of risk.

The product has the same shape. Room seats (`apps/server/src/services/rooms/reseat/reseat-accounts.ts`), heartbeats and, since DOR-5097, scheduled runs move to another account when theirs runs out. Each kind of turn decides this on its own, and not every kind does.

## Decision

We will treat an outside account as a single point of failure that every required gate must plan for.

- **The gate declares the dependency.** Any required gate whose verdict depends on an account outside the repo (a model account, a paid service) says so in its own entry in `ci/gates.yaml`, and names its second path there.
- **The second path needs no person.** It is a second credential from a different account, tried when the first is out. For the cloud review that means a second subscription sign-in, still not a metered API key: the team's rule that AI review runs on a subscription stands.
- **One alarm per outage.** When the first account is out, the PR says so in one line, and the team gets one alarm per outage that says when the account resets. Not one per PR.
- **The census enforces it.** The CI Steward census fails any required gate that depends on an outside account and declares no second path. A rule people must remember becomes a check.
- **Never degrade to pass.** A gate whose accounts are all out stays red. Being unable to decide is never the same as passing.
- **The product follows the same rule.** When an agent's account runs out, its next turn moves to another account the person allowed, by one shared rule for every kind of turn, and the chat says which (DOR-5190). The room seat picker is the starting point.

## Consequences

### Positive

- One account running out no longer stops every merge in the repo.
- The risk becomes visible: a reader of `ci/gates.yaml` can see which gates lean on an outside account and what happens when it is out.
- A new required gate with this weakness fails the census on the day it is added, not on the day its account runs out.
- The repo and the product answer "the account is out" the same way, so the lesson is learned once.

### Negative

- A second account is a second sign-in to hold, renew and keep secret. If both accounts belong to the same person, one rule change on the outside service can still stop both.
- The second account must be one whose terms allow this use. If none is, the second path has to be something other than a second sign-in, and this record does not say what.
- Two accounts that run out in the same week still stop merges. This makes the stop rarer and louder, not impossible.
- `ci/gates.yaml` gains a field and the census gains a rule, both of which need tests and upkeep.
- Moving every kind of agent turn onto one shared account rule touches several code paths that each decide this today.

## Alternatives considered

- **Let the gate pass when the reviewer is out.** Rejected: it removes the gate exactly when nobody is looking.
- **A person approves while the account is out.** Rejected: [260919-174348](260919-174348-merges-are-fully-autonomous-machine-gates-are-the-only-gates.md) rules out human approval before merge as a path, and the hand-signed marker already showed how slow that is at the pace PRs arrive.
- **Skip the gate for changes that touch no security path.** Not chosen now: it would keep docs and test PRs flowing, but it reverses part of DOR-5119, which made every PR need a Security sign-off. That is a separate decision for Security.
- **A metered API key as the second path.** Rejected: it breaks the team's rule that AI review runs on a subscription sign-in.
