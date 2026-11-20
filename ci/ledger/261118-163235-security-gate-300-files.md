---
id: 261118-163235
title: security-gate lists every file of a 300+ file queued commit instead of refusing it
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
hypothesis:
  metric: gate.wf.security-gate.security-gate.ejections_caused
  baseline: 1
  baseline_source: run 44341909211 on 2026-11-18 (PR #3934, 392 files, "Incomplete queued-head comparison"); snapshots/2026-11-17.json shows 42 of 42 merge_group runs green the day before
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

## Why

On `merge_group`, the gate reads each queued entry's files from `compare(base...head)`. GitHub returns at most 300 files there, so the gate refuses any entry with 300 or more: it can't tell a complete list from a cut-off one. That is correct to fail closed, but it means every PR with 300+ files is ejected, whatever its labels. #3934 (392 files) was ejected at 16:25:39Z on 2026-11-18 this way.

## What changes

- **Under 300 files: unchanged.** Compare is still the first read.
- **At 300 or more:** the queue squashes, so each entry's head is one commit whose only parent is the entry's base. The gate reads that commit's file list from `GET /commits/{head}`, page by page (`per_page=100&page=N`, until a short page), from the same two immutable SHAs. It never reads the PR's live files.
- **Still fails closed:** the head must have exactly one parent, equal to the entry's base; any API error, malformed page or repeat refuses; 3,000 files or more refuses (GitHub's cap there); and the full list must contain every one of compare's 300 files, or it refuses.

Revert if a merge_group run passes an entry whose full file list was not read, or if the gate's merge_group duration nears its 5-minute limit on a large entry.
