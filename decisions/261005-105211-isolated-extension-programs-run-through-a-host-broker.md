---
id: 261005-105211
title: An isolated extension cannot spawn; the host runs its declared programs for it
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105211. An isolated extension cannot spawn; the host runs its declared programs for it

## Status

Accepted

## Context

`--allow-child-process` is all or nothing. A JavaScript check inside the child, with the flag on, would be the only thing between the extension and every program on the computer.

## Decision

The child has no spawn right. Its `child_process` resolves to a shim whose async `spawn`, `execFile` and `exec` send requests to the host, which runs only programs listed in `allow.run`, by resolved absolute path, with `shell: false`, a working folder inside the extension's files folder or one of its projects, at most 8 at once, all killed when the extension stops. Synchronous forms are refused.

## Consequences

### Positive

- Which program runs is enforced by code the extension cannot touch.

### Negative

- A permitted program runs with the person's full authority; a shell or interpreter in `allow.run` means any program, and the approval card says so.
- Code using `execSync` and friends must move to async forms to run isolated.
