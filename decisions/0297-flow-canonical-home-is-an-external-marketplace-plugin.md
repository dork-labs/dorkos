---
number: 297
title: Flow's canonical home is an external marketplace plugin, not dorkos
status: accepted
created: 2026-06-27
spec: flow-plugin-extraction
superseded-by: null
---

# 297. Flow's canonical home is an external marketplace plugin, not dorkos

## Status

Accepted

## Context

ADR-0281 made dorkos's `.agents/flow` the canonical source, built and projected out to the marketplace.
The operator rejected that on two firm grounds: 100% of flow must live in ONE location that is NOT the
dorkos repo (so the plugin can be modified entirely in one place), and the source/artifact split (TS
source in dorkos, compiled artifact shipped to the marketplace) is unacceptable. The marketplace already
links plugins by git URI (`relative-path` / `git-subdir` / `github` / `url`) and already ships a
scaffolder, validator, and installer, so an external-canonical plugin needs no new platform tooling.

## Decision

Flow's canonical home is a single self-contained plugin at `dork-labs/marketplace/plugins/flow/`. It
holds 100% of flow content (commands, skills, hooks, the engine source + tests, scripts, adapters,
config, docs). dorkos stops being flow's home and becomes a CONSUMER that dogfoods the external plugin.
This SUPERSEDES ADR-0281.

## Consequences

### Positive

- One editable location for the whole plugin; matches how every existing marketplace plugin already lives.
- True decoupling: flow is a real, independently-installable plugin, not a dorkos-internal subsystem.
- No new platform tooling required (the marketplace source-resolver / validator / installer exist).

### Negative

- dorkos must consume flow externally (interim `claude --plugin-dir`; the blessed install + contribute
  loop is DOR-146/147/148, tracked as cleanup DOR-172).
- The migration spans two repos and is outward-facing (creating + pushing a plugin to the marketplace).
- Supersedes a still-proposed ADR (0281); the reversal must be recorded for auditability.
