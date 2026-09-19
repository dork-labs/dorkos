# ci-steward-data

Machine-owned observations of the CI pipeline, written by the CI Steward collector
(`.github/workflows/ci-steward.yml`) and by `ci-steward local-export`. Append-only: ruleset
23704437 forbids deletion and force-push, and weekly backup tags are permanent.

Read it with `pnpm ci:status`, or `git show origin/ci-steward-data:latest.json`. The file
formats are defined in `packages/ci-steward/src/data.ts` on the default branch. Never edit by hand.
