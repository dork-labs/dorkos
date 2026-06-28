---
number: 299
title: dorkos consumes flow as an external plugin via --plugin-dir (interim)
status: accepted
created: 2026-06-27
spec: flow-plugin-extraction
superseded-by: null
---

# 299. dorkos consumes flow as an external plugin via --plugin-dir (interim)

## Status

Accepted

## Context

With flow's canonical home external (ADR-0297), dorkos, which uses `/flow` heavily for its own daily
development, must consume it. The blessed dev loop (DOR-146 documented `--plugin-dir`, DOR-147 install
provenance, DOR-148 `dorkos contribute`) is not built yet, but `claude --plugin-dir` exists today and the
marketplace install path already supports git-URI sources.

## Decision

dorkos dogfoods the external flow plugin via `claude --plugin-dir <local-clone>/plugins/flow`, which loads
the plugin's commands, skills, and Stop hook for the session (the manual `/flow` path). The Pulse
`flow-drain` tick ships in the plugin as a skill with `cron` + `enabled: false` and is inert in v1, so
manual dogfood does not depend on the server task system. dorkos's in-repo flow source is removed ONLY
after consumption is proven end-to-end (the never-without-a-working-/flow sequencing). Migrating this
interim consumption to the blessed install + provenance + `dorkos contribute` loop is captured as DOR-172
(blocked by DOR-146 + DOR-148).

## Consequences

### Positive

- dorkos dogfoods the external plugin today, with no new tooling.
- The sequencing (stand up, prove, consume, then remove) guarantees dorkos never loses a working `/flow`.

### Negative

- The interim `--plugin-dir` / symlink dogfood is hand-rolled until DOR-146/148 land (DOR-172 debt).
- Autonomous-tick firing inside dorkos (the server task system discovering plugin-shipped tasks) is a
  deferred follow-up, out of v1 scope.
