---
id: 261005-105209
title: An extension may run its server half as its own Node process under the permission model
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: 0213
---

# 261005-105209. An extension may run its server half as its own Node process under the permission model

## Status

Accepted

Amends 0213: its clause that server code "runs in-process with no isolation boundary" no longer holds for every extension. 0213 still stands as the default: an extension that does not ask for `runtime: "subprocess"` is loaded in-process exactly as 0213 describes.

## Context

ADR 0213 runs `server.ts` inside the DorkOS process with full authority, so one crash, heap death or hang takes DorkOS down, and an extension that parses hostile input (mail, web pages) has every right DorkOS has. Node's permission model is process-wide and DorkOS itself cannot run under it, so a worker thread would inherit the server's rights, and `process.abort()` in a worker still ends DorkOS. `isolated-vm` breaks ordinary Node libraries and adds a native addon.

## Decision

An extension that declares `serverCapabilities.runtime: "subprocess"` runs in its own Node process, forked with `--permission`, exactly two real-path read grants (a staged run folder holding the bootstrap, the bundle and `assets/`, and its own files folder), one write grant (its files folder), a heap cap from `limits.memoryMb`, and an environment built from nothing. Child processes, workers, addons, WASI and the inspector are never granted; `"worker"` is refused as a runtime. A watchdog kills a hung child, and an unexpected exit restarts it on a 1 s / 5 s / 30 s backoff until three inside 10 minutes leave it stopped. In-process stays the default.

## Consequences

### Positive

- A crash, heap death or hang stays in one extension; DorkOS keeps serving.
- File and process limits are enforced by Node, not by the code they restrict.
- The two-grant layout sidesteps a Node permission-tree bug that made a shared parent readable with three or more grants.

### Negative

- About 40 MB and 100 ms per isolated extension, and every ctx call is an IPC round trip.
- Node disclaims the model against deliberately malicious code: this contains honest and input-compromised code, not a hostile author.
- The client bundle is not isolated; an extension with screens is only as limited as they are.
