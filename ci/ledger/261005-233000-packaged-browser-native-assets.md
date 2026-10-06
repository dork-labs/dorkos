---
id: 261005-233000
title: Package the original native browser workers with the CLI
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The existing CLI build ships the fresh installation verifier but omits the native journal and supervisor workers and observer used by the genuine production engine. Package those exact original workers and build-host observer output, and bind their bounded manifest to the actual CLI bytes. Unsupported build hosts retain explicit unavailable native output. The runtime resolves fixed package-relative assets through bounded, nofollow, re-observed original file reads and rejects changed outputs before engine construction.

This adds functional package assets; it changes no required checks, retries, timeouts, discovery or pipeline configuration. Revert the producer if the packaged output fails its strict original manifest controls. Native availability and ordinary production readiness remain separate runtime proofs, never a source manifest claim.
