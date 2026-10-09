---
id: 261009-021019
title: Package the closed browser VM release bank with the original application graph
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.cli-smoke-test.build-tarball
  - wf.credential-free-build.credential-free-build
  - wf.desktop-smoke.packaged-runtime
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
prs: [2686]
ratchet-release: []
field-changes: []
---

The VM runtime needs its exact signed release assets beside the same application module graph that owns its local capabilities. CLI and desktop bundlers retain that graph; the unbundled server copies the closed 36-module production list. An empty accepted release selection stays off. A selected bank must pass independent compiled-anchor, manifest and streamed content checks. Desktop signing preserves and verifies the seven already-signed assets instead of changing their recorded bytes.

The copier refuses symlinked output parents before removal. Mac build paths stop producing the superseded observer/library bank; existing non-Darwin paths remain. The default browser package build now emits TypeScript only; the same original native observer command remains explicit in build:native-fixture and test:fixture. This is packaging correctness and containment hygiene, with no performance hypothesis or invented baseline. No required context, quality floor, retries, shard count, timeout, event, workflow, allowlist or steward code changes.

Local evidence: the original copier deleted an external sentinel through a symlinked parent; the fixed copier refused the same fixture and preserved it. Root separately executed six copier controls and the new signer-filter/YAML controls. The fixed 36-module copying controls and CLI/desktop script types/lint remain adoption checks. These controls do not prove a signed release package, VM readiness or persistent profile recovery.

Revert the affected copying/signing/build changes together if they split the original module graph, alter pre-signed asset bytes, permit output path aliases, or make empty selection arm a runtime. Do not restore obsolete Mac assets as a runtime fallback. The old manually dispatched native-artifact workflow remains a separate release-path mismatch; this entry neither repairs nor waives it.
