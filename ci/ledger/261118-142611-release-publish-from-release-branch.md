---
id: 261118-142611
title: Release Publish workflow publishes a release/vX.Y.Z tip from main's proofs
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.release-publish.prepare
  - wf.release-publish.publish
prs: []
ratchet-release: []
field-changes: []
---

Why: releases move to their own `release/vX.Y.Z` branch so `main` stops freezing (ADR 261118-135124, DOR-4638). Security ruled that a release-branch publish runs on GitHub, from main's copy of the workflow, after one person approves it from an account the agents' token cannot act as, with npm trusted publishing and no npm token.

What: a new `workflow_dispatch`-only workflow, run on `main` only. It adds no required check, no PR or queue job, and runs only when someone dispatches it, so it costs no CI time on any PR. `prepare` (contents, actions and attestations read) checks out the release branch as data at the dispatched SHA, runs main's `release-cli.ts` proofs (tip equals the named SHA, base is QA's pin or a published tag, only main cherry-picks plus the release commit) and packs the three packages. `publish` (environment `npm-release`, `id-token: write`) checks the run's approvals API for the hardcoded approver, re-checks the tip, checks each tarball's digest and manifest, and runs `npm publish` on the exact tarballs. Every action is pinned to a SHA; inputs reach scripts only through `env:`.

Revert if: the pilot release (DOR-4644) cannot publish through it, or it ever publishes a commit other than the dispatched SHA. The local `publish:cli` main-ancestor path is unchanged and stays the fallback.
