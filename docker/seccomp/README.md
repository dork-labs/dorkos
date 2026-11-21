# Seccomp profile for Codex in Docker

Codex keeps each command it runs in a sandbox. Docker's default seccomp profile (the list of system calls a container may make) blocks what that sandbox needs to start, so Codex in the DorkOS image stops before it does anything. `dorkos-codex.json` is a profile you can opt into that lets it start. How to use it is in the [Docker guide](../../docs/self-hosting/docker.mdx#running-codex-in-docker). dorkos.ai serves the same file at https://dorkos.ai/dorkos-codex.json.

Only use it if you run Codex. Every other way of running the image stays on Docker's default profile.

Where it works: Docker Desktop on a Mac (checked 2026-11-20, Docker 29.9.2, linux/arm64). Docker Desktop on Windows and Linux hosts without AppArmor run the same way but haven't been checked. On Ubuntu and Debian, whose Docker uses the `docker-default` AppArmor profile, the sandbox still can't start: seccomp lets it make its namespace, then AppArmor refuses its first mount (`bwrap: Failed to make / slave: Permission denied`). Codex in Docker is not supported there yet (DOR-4836), and there is no supported workaround.

## What it changes

`dorkos-codex.json` is Docker's default profile with one rule added at the end. That rule allows five system calls: `clone`, `mount`, `pivot_root`, `umount2` and `unshare`. Codex's sandbox uses them to give each command its own private view of the files and processes.

What that means for the container:

- It adds no capabilities (Linux's named extra powers), and DorkOS still runs as the unprivileged `node` user.
- It does let any program in the container create user namespaces and mount file systems inside them, where the host's kernel allows that. Docker's default allows those calls only to a process holding `CAP_SYS_ADMIN`. That is the whole widening, and the reason the profile is opt-in.

Everything else in the file has the same structure and content as Docker's default: the test compares the two as parsed JSON.

## Where it comes from

| File                                 | What it is                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `upstream-default-9ee3204f0d0c.json` | Docker's default profile, unchanged: `seccomp/default.json` from `moby/profiles` at the commit below |
| `dorkos-codex.json`                  | That file plus the one rule above                                                                    |
| `LICENSE`                            | The Apache License 2.0 text from `moby/profiles` at the same commit                                  |

- Upstream: https://github.com/moby/profiles, commit `9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae`
- Raw file: https://raw.githubusercontent.com/moby/profiles/9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae/seccomp/default.json
- Licence: Apache License 2.0, by the Moby project authors (`LICENSE` here). `dorkos-codex.json` is a modified copy; its added rule carries a `comment` saying so.

Prettier skips both JSON files (`.prettierignore`), so `diff upstream-default-9ee3204f0d0c.json dorkos-codex.json` shows only the added rule. `apps/site/public/dorkos-codex.json` is the copy the website serves; the test holds it byte for byte to `dorkos-codex.json`.

## What keeps it honest

- `scripts/__tests__/codex-seccomp-profile.test.ts` checks the upstream copy's sha256 against the pinned commit, and fails if `dorkos-codex.json` differs from it in any way beyond that one rule with exactly those five system calls.
- `scripts/codex-docker-sandbox-check.sh` runs the image both ways. `--expect full` is the outcome above on a host without AppArmor; `--expect apparmor` is the Ubuntu outcome, where the profile run must fail on the AppArmor mount refusal and never on the namespace refusal. In the full outcome, Codex's sandbox starts and still refuses a write outside the folder it was given. In both, the container keeps the same user, capability sets, `NoNewPrivs` and AppArmor label as with the default, and with Docker's default the sandbox refuses to start. The `codex-docker-sandbox` job in `.github/workflows/cli-smoke-test.yml` runs it with `--expect apparmor` on a fresh Ubuntu host against an image built from the pull request.
- What the check does not cover: the per-turn `dorkos-files-*` profile DorkOS gives Codex (which is what keeps `~/.dork` closed when Codex works from your home folder). It checks Codex's own workspace limit only.

## Updating the base

To move to a newer Docker default: download `seccomp/default.json` at the new `moby/profiles` commit into a new `upstream-default-<first 12 of the sha>.json`, delete the old one, rebuild `dorkos-codex.json` as that file plus the same rule, copy it to `apps/site/public/dorkos-codex.json`, then update the commit and sha256 in the test and the links above. Any change to the added rule itself needs a new security review.
