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

A new, non-required job in `cli-smoke-test.yml`, on the same path filter as its siblings plus `docker/seccomp/**` and its own script. It builds the `runtime` Docker stage (the product image) from the PR's tarball and runs `scripts/codex-docker-sandbox-check.sh` against it twice, on GitHub's Ubuntu host left at its defaults. GitHub's Ubuntu runner enforces Docker's `docker-default` AppArmor profile, so the job runs the script with `--expect apparmor`: with `docker/seccomp/dorkos-codex.json` (Docker's default profile plus one rule allowing `clone`, `mount`, `pivot_root`, `umount2` and `unshare`), Codex's sandbox must fail on `bwrap: Failed to make / slave: Permission denied` (AppArmor's mount refusal) and never on `bwrap: No permissions to create a new namespace` (seccomp's), the failed sandbox must write nothing, and the container must keep uid 1000, the same capability sets, `NoNewPrivs` and AppArmor label as the default run, with seccomp filtering in both. With Docker's default profile the sandbox must fail closed. Nothing else in the repo proves the profile Security reviewed for DOR-3800 actually works, or that it adds nothing beyond that.

The bet is that the job is deterministic: a failure rate at or under 2% over 14 days, since it runs on every push to `main` and main-green is the current constraint. Revert or rethink if it goes red on pushes that did not touch Docker, Codex or the profile (that would mean the runner host changed under it, not that it caught something). A red that says the runner gave the full outcome (no AppArmor) or an unknown AppArmor label means the host changed: re-read the host settings step before touching the assertion.

Evidence:

- **Full outcome, Docker Desktop for Mac, 2026-11-20:** Docker 29.9.2 (linux/arm64), image `ghcr.io/dork-labs/dorkos:0.138.0`, `--expect full`: Codex's sandbox started in workspace-write and read-only, refused a write to `~/.dork` from `~/work`, and every capability set, `NoNewPrivs` and the AppArmor label (`none`) matched the default run, with `Seccomp: 2` in both. With Docker's default profile both modes failed on the namespace refusal.
- **Ubuntu runner, 2026-11-20:** Docker 29.4.2 (amd64), image built at a30c3b7f28, https://github.com/dork-labs/dorkos/actions/runs/44730199235. With the profile both modes failed on `bwrap: Failed to make / slave: Permission denied`; with the default, on `bwrap: No permissions to create a new namespace`. `CapEff` matched and both runs were uid 1000. The host was at its defaults (`kernel.apparmor_restrict_unprivileged_userns = 1`). That run used the earlier full-pass assertions, so it went red; this entry's job asserts the scoped outcome instead. Codex in Docker on AppArmor hosts is DOR-4836.
