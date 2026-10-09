---
id: 261006-230000
title: 'Desktop browser: preserve one verified unpacked runtime tree'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
prs: []
ratchet-release: []
field-changes: []
---

The desktop server build now uses the original CLI browser asset producers. The real unpacked controller, package metadata, dependencies, verifier and native workers share one package tree. The packager otherwise trims files from the pinned browser SDK; a hook restores that same dependency directory, preserves the archive payload, and updates the matching archive-header integrity hash before signing. No workflow, timeout, warning allowance or required check changes.

This is packaging hygiene for the browser feature, not a CI speed experiment. Platform acceptance remains macOS Apple Silicon only; portable checks do not establish a successful installed app or upgrade/rollback. Revert these packaging declarations and hook together if a signed artifact fails its original package checks.
