---
id: 261010-193941
title: Sweep the managed-browser runs' public-native-<uuid> homes
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

On 2026-10-10 this Mac's `$TMPDIR` held 42 folders named
`public-native-<uuid>`, each a whole DorkOS data folder with its own browser
download (about 400-500 MB). The managed-browser acceptance runs behind PR
#2686 make one per run and keep it. `scripts/sweep-test-tmp.sh` never saw them:
it only matches mkdtemp's `<prefix>-XXXXXX` shape.

The sweep now also matches a short second allowlist whose suffix is one
lowercase UUID, starting with `public-native`. Every other rule is unchanged:
the 24 hour age floor, the `lsof` in-use check, the root checks. The fixtures
job's existing step, `bash scripts/test-sweep-test-tmp.sh`, gains one case with
a positive control for each keep (young, open, wrong shape).

No required check, deadline, shard, retry or coverage rule changes. Revert if
the sweep ever removes a `public-native-*` folder a run still needed; the age
floor and `lsof` check are what stop that.
