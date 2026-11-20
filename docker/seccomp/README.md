# Seccomp profile for Codex in Docker

Codex keeps each command it runs in a sandbox. Docker's default seccomp profile (the list of system calls a container may make) blocks what that sandbox needs to start, so Codex in the DorkOS image stops before it does anything. `dorkos-codex.json` is a profile you can opt into that lets it start. How to use it is in the [Docker guide](../../docs/self-hosting/docker.mdx#running-codex-in-docker).

Only use it if you run Codex. Every other way of running the image stays on Docker's default profile.

## What it changes

`dorkos-codex.json` is Docker's default profile with one rule added at the end. That rule allows five system calls: `clone`, `mount`, `pivot_root`, `umount2` and `unshare`. Codex's sandbox uses them to give each command its own private view of the files and processes. They do not add any capability (an extra power) to the container, and the container still runs as the unprivileged `node` user. Everything else in the file is byte-for-byte Docker's default.

## Where it comes from

| File                                 | What it is                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `upstream-default-9ee3204f0d0c.json` | Docker's default profile, unchanged: `seccomp/default.json` from `moby/profiles` at the commit below |
| `dorkos-codex.json`                  | That file plus the one rule above                                                                    |

- Upstream: https://github.com/moby/profiles, commit `9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae`
- Raw file: https://raw.githubusercontent.com/moby/profiles/9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae/seccomp/default.json
- Licence: Apache License 2.0, by the Moby project authors (https://github.com/moby/profiles/blob/9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae/LICENSE). `dorkos-codex.json` is a modified copy; its added rule carries a `comment` saying so.

Prettier skips both files (`.prettierignore`), so `diff upstream-default-9ee3204f0d0c.json dorkos-codex.json` shows only the added rule.

## What keeps it honest

- `scripts/__tests__/codex-seccomp-profile.test.ts` checks the upstream copy's sha256 against the pinned commit, and fails if `dorkos-codex.json` differs from it in any way beyond that one rule with exactly those five system calls.
- `scripts/codex-docker-sandbox-check.sh` runs the image both ways. With this profile, Codex's sandbox starts, it still cannot write to `~/.dork`, and the container has the same capabilities and user as with the default. With Docker's default, the sandbox refuses to start. The `codex-docker-sandbox` job in `.github/workflows/cli-smoke-test.yml` runs it on a fresh Ubuntu host against an image built from the pull request.

## Updating the base

To move to a newer Docker default: download `seccomp/default.json` at the new `moby/profiles` commit into a new `upstream-default-<first 12 of the sha>.json`, delete the old one, rebuild `dorkos-codex.json` as that file plus the same rule, then update the commit and sha256 in the test and the links above. Any change to the added rule itself needs a new security review.
