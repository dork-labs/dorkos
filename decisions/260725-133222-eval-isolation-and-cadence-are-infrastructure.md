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

We will add a `docker` isolation tier on the existing `IsolationLauncher` seam that mounts exactly one path (the per-eval `mkdtemp` sandbox), forwards a curated env rather than the harness's process environment, gives the container **no network, no Linux capabilities, and bounded memory/CPU/pids**, and removes the container on success while retaining it on failure for debugging. Cases opt in through `preferDocker` metadata and degrade to the child-process tier with a clear message when no daemon is present, so the absence of Docker is never a hard failure. Eval cadence is deliberately opt-in: per-PR runs happen only behind a `run-evals` label, a nightly schedule runs the credential-free structural suite, and credentialed runs are `workflow_dispatch` only with the model key pinned to a single named secret. Promotion of a quarantined case out of quarantine stays a human decision on green evidence; no workflow edits code.

## Consequences

### Positive

- Destructive-scenario evals can run for real, with containment verified by inspecting the running container rather than trusting the launcher's own report.
- PRs cost nothing until someone asks for evals, and no credential is spent without an explicit dispatch.
- Pinning the secret name removed a path where naming the wrong secret would have shipped an unrelated token to a third party's request logs.

### Negative

- The Docker tier needs a locally built image and is not exercised in per-PR CI, so it can rot between uses; the skip path is what keeps that from breaking anyone.
- `--network none` makes docker's port publishing inert, so reachability costs a host-side proxy that relays each connection through `docker exec` into the container's network namespace — one subprocess per TCP connection, and a dependency on `node` existing in the eval image (it does; it is the image's runtime).
- The container's root filesystem stays writable. `--read-only` was not adopted because no credentialed run has established which paths the `claude` binary needs, and an unverified flag that breaks the tier is worse than a disposable writable layer.

## Amendment (2026-07-25)

The tier as first built passed no `--network`, `--cap-drop`, or resource limits. A container launched with those exact flags reached `https://example.com` and `http://host.docker.internal:11434` — i.e. the developer's own DorkOS on loopback, whose `DORK_HOME` is the real `~/.dork` — while the launcher's docstring and the changelog told users the agent "can only touch a throwaway folder". The filesystem claim was true; the containment claim was not.

Closing it required discovering that `--network none` and `--publish` cannot coexist: docker accepts both and the published host port then never answers. Two alternatives were measured and rejected on Docker Desktop — an `--internal` network still reached `host.docker.internal` AND broke publishing, and a bridge with `enable_ip_masquerade=false` closed nothing. Hence the namespace proxy above. Verified against the real eval image: `net=none`, `ports=map[]`, one bind mount, `CapDrop=[ALL]`, `no-new-privileges`, memory == memory-swap, `pids-limit`; `/api/health` and a streaming `/api/events` both answer through the proxy; egress and host loopback both refuse.
