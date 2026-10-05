---
id: 261005-105215
title: An isolated extension that cannot confirm its limits does not run at all
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105215. An isolated extension that cannot confirm its limits does not run at all

## Status

Accepted

## Context

The packaged desktop app runs the server in Electron, where Node's permission model in run-as-node mode had to be proven, and a future Electron fuse change could disable run-as-node. Node's permission tree has had bugs that widened grants. Running an extension "isolated" with full rights would be worse than running it in-process, because the person was told otherwise.

## Decision

The child's first message reports what the permission model allows, including probes of the data directory and every folder above a grant. The host refuses unless the model is present, the control read of the child's own bootstrap succeeds, and every withheld capability reads as denied. A refusal leaves the extension off with `isolation_unavailable`. There is never a fallback to in-process.

## Consequences

### Positive

- No extension ever runs "isolated" with full rights.

### Negative

- On a computer that cannot isolate, an isolated extension does not run until that is fixed.
