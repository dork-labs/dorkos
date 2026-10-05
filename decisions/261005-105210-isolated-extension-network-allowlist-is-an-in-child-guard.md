---
id: 261005-105210
title: An isolated extension's network allowlist is a guard inside its process, never called a firewall
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105210. An isolated extension's network allowlist is a guard inside its process, never called a firewall

## Status

Accepted

## Context

Node has no network permission on the supported floor: `--allow-net` is not an option, and `fetch` succeeds under `--permission`. OS sandboxes differ per platform (and are deprecated on macOS), and an egress proxy only covers clients that honour it.

## Decision

Before extension code loads, the child bootstrap wraps socket connect (which `net`, `tls`, `http(s)`, `http2` and `fetch` all reach), every DNS entry point, UDP sockets and `listen`, using captured intrinsics. Connections go only to `allow.net` host:port matches; DNS answers are re-checked so a listed name cannot rebind to a loopback or private address; DorkOS's own port is always refused. The permission model closes the guard's escape routes (bindings, addons, child processes, workers). App copy and docs describe it as a check inside the extension's process, never as a sandbox or firewall.

## Consequences

### Positive

- Hostname-accurate, cross-platform, no extra binary.
- Real against ordinary code and code compromised through its input.

### Negative

- Not an OS firewall: a missed builtin path or a Node or V8 bug defeats it.
- Upgrade path without a manifest change: Node's own network permission once the floor has it, and an OS layer beneath the guard per platform.
