---
id: 261120-111426
title: Codex's sandbox starts in the product image only with the opt-in seccomp profile
kind: experiment
status: proposed
actor: agent
gates: [wf.cli-smoke-test.codex-docker-sandbox]
prs: []
hypothesis:
  metric: gate.wf.cli-smoke-test.codex-docker-sandbox.failure_rate
  slo: main-green
  baseline: null
  baseline_source: 'null: the job is new, so there is no failure rate of its own to start from. For context, its workflow, cli-smoke-test.yml, which runs on every push to main, finished green in all of its last 60 runs on main (2026-11-18T19:41Z to 2026-11-20T10:44Z, gh run list --workflow cli-smoke-test.yml --branch main -L 60); its sibling Docker jobs integration-test and hub-smoke-test took 1.6 to 2.1 minutes in them. main-green is the constraint in latest.json of 2026-11-18 (26 red episodes), which is why the bet is on failures rather than time.'
  target: 0.02
  after_days: 14
ratchet-release: []
field-changes: []
---

A new, non-required job in `cli-smoke-test.yml`, on the same path filter as its siblings plus `docker/seccomp/**` and its own script. It builds the `runtime` Docker stage (the product image) from the PR's tarball and runs `scripts/codex-docker-sandbox-check.sh` against it twice, on GitHub's Ubuntu host left at its defaults. With `docker/seccomp/dorkos-codex.json` (Docker's default profile plus one rule allowing `clone`, `mount`, `pivot_root`, `umount2` and `unshare`), Codex's sandbox must start in workspace-write and read-only, must still refuse a write outside the folder it was given (`~/.dork`, from a workspace at `~/work`), and the container must keep uid 1000, the same capability sets, `NoNewPrivs` and AppArmor label as the default run, with seccomp filtering in both. With Docker's default profile the sandbox must fail closed. Nothing else in the repo proves the profile Security reviewed for DOR-3800 actually works, or that it adds nothing beyond that.

The bet is that the job is deterministic: a failure rate at or under 2% over 14 days, since it runs on every push to `main` and main-green is the current constraint. Revert or rethink if it goes red on pushes that did not touch Docker, Codex or the profile (that would mean the runner host changed under it, not that it caught something), or if GitHub's runner turns out to block the sandbox even with the profile, in which case that host is not supported and the docs must say so.
