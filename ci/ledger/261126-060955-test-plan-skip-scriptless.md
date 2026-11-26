---
id: 261126-060955
title: The test plan never selects a package with no test script
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`scripts/pr-test-plan.sh` keeps the `test` tasks whose turbo hash moved. Turbo lists a `test` task for every package, and gives one with no `test` script (`@dorkos/eslint-config`, `@dorkos/typescript-config`) the command `<NONEXISTENT>`. A change to such a package selected that "suite", and the merge queue's "Prove the suite actually executed" step then refused the plan on every shard, ejecting #4496 twice. The planner now drops `<NONEXISTENT>` tasks. A package with no tests has nothing to run, so nothing is lost. The planner is read from the base commit, so the fix applies to PRs queued after it lands. Revert if a package with a real `test` script is ever dropped (the new test pins that one with a command stays).
