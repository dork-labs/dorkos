---
number: 273
title: Unify the Harness Under One /flow Engine with a Single Stage Model
status: draft
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 273. Unify the Harness Under One /flow Engine with a Single Stage Model

## Status

Draft (auto-extracted from spec: unified-workflow-system)

## Context

Three harness subsystems — ideation/spec/execution, Linear integration, and workspace management — grew independently, producing four unsynchronized notions of "where work is" (spec status, PM state, labels, loop phase), two mutually-unaware loops, thick commands (250–590 LOC), and breadcrumb logic copy-pasted four times.

## Decision

Consolidate into one `/flow` orchestrator plus `/flow:<stage>` thin triggers (≤~40 LOC each) over generic, auto-invocable gerund stage skills. Define one canonical stage model (CAPTURE→TRIAGE→IDEATE→SPECIFY→DECOMPOSE→EXECUTE→VERIFY→REVIEW→DONE) from which spec status, PM state, labels, and loop phase are all projected via a tracker adapter. Hard rename of legacy commands, no aliases.

## Consequences

### Positive

- One identifiable system under a single command prefix; PM-agnostic by construction.
- Eliminates drift between four independent state models and two loops.
- Thin commands keep logic in reusable, testable skills.

### Negative

- Large one-time refactor and breaking command renames for existing muscle memory.
- A single stage model must accommodate every workflow shape, requiring careful projection rules.
