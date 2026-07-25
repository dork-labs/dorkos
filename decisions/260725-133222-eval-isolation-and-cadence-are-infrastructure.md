---
id: 260725-133222
title: Eval isolation is a container, and eval cadence is opt-in
status: accepted
created: 2026-07-25
spec: agent-trust
superseded-by: null
---

# 260725-133222. Eval isolation is a container, and eval cadence is opt-in

## Status

Accepted

## Context

The eval harness could only run agents in-process or as a host child process, so destructive-scenario evals had no way to be genuinely contained, and nothing ran evals on a schedule. Both gaps were designed in the eval-harness spec (DOR-357) and never built. Governance evals in particular need to let an agent actually attempt an irreversible action, which is not something to run against a developer's real home directory.

## Decision

We will add a `docker` isolation tier on the existing `IsolationLauncher` seam that mounts exactly one path (the per-eval `mkdtemp` sandbox), forwards a curated env rather than the harness's process environment, and removes the container on success while retaining it on failure for debugging. Cases opt in through `preferDocker` metadata and degrade to the child-process tier with a clear message when no daemon is present, so the absence of Docker is never a hard failure. Eval cadence is deliberately opt-in: per-PR runs happen only behind a `run-evals` label, a nightly schedule runs the credential-free structural suite, and credentialed runs are `workflow_dispatch` only with the model key pinned to a single named secret. Promotion of a quarantined case out of quarantine stays a human decision on green evidence; no workflow edits code.

## Consequences

### Positive

- Destructive-scenario evals can run for real, with containment verified by inspecting the running container rather than trusting the launcher's own report.
- PRs cost nothing until someone asks for evals, and no credential is spent without an explicit dispatch.
- Pinning the secret name removed a path where naming the wrong secret would have shipped an unrelated token to a third party's request logs.

### Negative

- The Docker tier needs a locally built image and is not exercised in per-PR CI, so it can rot between uses; the skip path is what keeps that from breaking anyone.
- Orphaned containers after a hard harness kill are cleaned up by a documented label sweep rather than automatically.
