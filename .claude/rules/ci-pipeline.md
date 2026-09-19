---
paths: .github/workflows/**, lefthook.yml, turbo.json, .claude/settings.json, .claude/hooks/**, ci/**, scripts/**, packages/ci-steward/**, .agents/skills/creating-pull-requests/**, REVIEW.md
---

# CI Pipeline Change Protocol

You are editing a gate source. Merges into `main` are fully autonomous, so the pipeline is the only thing between an agent and `main`, and every change to it is an experiment that CI Steward records and later judges. Full guide: `contributing/ci.md`; method: the `stewarding-ci-pipeline` skill (which carries this protocol for harnesses that do not load rules).

1. **State a hypothesis before you change anything:** one metric from `ci/metrics.yaml` (the narrowest that can move), its baseline, a target and `after_days`. "Faster" is not a hypothesis. `kind: hygiene` is the only kind exempt.
2. **Add a ledger entry in the same commit:** `node packages/ci-steward/src/cli.ts ledger-new --slug <slug>` scaffolds `ci/ledger/<YYMMDD-HHMMSS>-<slug>.md` (`--help` for flags). Until phase 1 publishes baselines, copy the baseline by hand and name its source in `baseline_source:`. Never write `verified`, `failed` or `inconclusive`: verdicts are computed, and the ledger check rejects them on `main`.
3. **Ratchet releases block review by default.** Lowering a quality floor (`ratchet-release`) needs a specific reason. Changing a required gate's retries, shards, timeout or required status needs `field-changes`.
4. **The deadlock invariant.** A required check's job must exist under that exact name, run on `pull_request` (with `synchronize` if `types:` is set) **and** `merge_group`, have no `paths:` filter, and not skip via a job-level `if:`. A skipped run satisfies a required context. Every job needs `timeout-minutes`; `continue-on-error` in a required job needs a `ci/census-allowlist.yaml` entry with `expires:`; an event-branching step `if:` needs one with a reason. An expired entry reds every PR, so schedule changes as dates in `ci/config.yaml`, never as expiries.
5. **Required-set changes: ledger release first, ruleset edit second.** Land the job, `ci/required-checks.json` and the ledger entry through a PR; the ruleset edit comes after. Nothing in Actions may hold an admin credential.
6. **The fence.** Unattended changes (`ci-improve/*`) may change gates, never the steward or the judge: nothing in `ci/steward-owned-paths.json`.
7. **Check before you push:** `node packages/ci-steward/src/cli.ts census` (`--fix` regenerates the required-checks blocks), `node packages/ci-steward/src/cli.ts ledger-check`, and `ledger-check --coverage --base "$(git merge-base origin/main HEAD)"`.
8. **Observations** live on the `ci-steward-data` branch from phase 1: `git fetch origin ci-steward-data && git show origin/ci-steward-data:latest.json` (also `:verdicts/<ledger-id>.json`, `:reports/<YYYY-Www>.md`).
9. **Never** push an empty commit, update a branch, or merge with `--admin` to get a change through. `/ci:status`, `/ci:record`, `/ci:improve` and `/ci:break-glass` are later phases and do not exist yet.
