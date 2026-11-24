---
id: 261012-211000
title: Local agent computers use a direct Linux VM and an isolated runtime
status: accepted
created: 2026-10-12
spec: agent-computer-mvp
superseded-by: null
amends: null
---

# 261012-211000. Local agent computers use a direct Linux VM and an isolated runtime

## Status

Accepted (2026-11-24, on review: built; PR #2845, `apps/server/src/services/computers/`, off by default behind `computers.enabled`). It is still the known exception to the shared runtime conformance suite until DOR-4902 lands.

**Amended by** [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md) (accepted 2026-11-24): `computer-local` forwards OpenCode's own protocol for now, and moves onto the one contract between the space side and the computer side. The sealing rules stand as built: no host mounts, the guest firewall and the takeover lease.

Proposed (2026-10-12; spec `agent-computer-mvp`, issue DOR-2748).

## Context

An agent needs a persistent computer whose files, browser and vendor sign-in are separate from the person's Mac. The existing managed-browser work provides useful lifecycle and control patterns, but its unfinished custom guest qualification does not establish a working general computer. The first experiment needs one supported local host and an actual brain running inside Linux.

## Decision

Use a pinned Lima VZ virtual machine directly on Apple Silicon. The guest has no host filesystem mounts, SSH-agent forwarding, host vendor credentials or model environment. A non-root OpenCode server owns its own sign-in and session history. Register it as a distinct `computer-local` runtime with an independent session map and an explicit disabled credits callback. Translate only structural SDK directory fields between a metadata-only host anchor and the guest project.

Show the same guest X display through a bounded authenticated PNG helper. Typed input requires the current generation and takeover lease. Freeze the agent process group during takeover; release held keys and buttons on return or expiry. Stop retains the owned disk. Uncertain ownership or interrupted lifecycle is a visible refusal, never permission to replace a disk.

DorkOS tools retain the existing turn-bound principal through a narrow fixed-target MCP bridge. Guest firewall policy denies host, LAN, metadata and IPv6 access except required DNS and that single bridge port. Cloud transfer and other desktop hosts are outside this experiment.

## Consequences

This removes a container layer and avoids qualifying another bespoke guest build. It still requires actual VM, network, persistence, input and installed-app proof before claiming readiness. Frame polling is sufficient for the initial visible desktop; its latency and bandwidth are limitations to measure. Vendor login belongs to the guest and must be completed separately.
