---
id: 261111-085826
title: "The Docker and Homebrew release jobs refuse a version that isn't a plain release, and pass every run: value through env"
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.publish-docker.build-and-push
  - wf.publish-docker.build-and-push-hub
  - wf.publish-docker.mirror-docker-hub
  - wf.update-homebrew.update-formula
prs: []
ratchet-release: []
field-changes: []
---

A safety fix, not an experiment: nothing measurable should move on a real release (DOR-4175). Every job in `publish-docker.yml` took its version from the pushed tag name with `${GITHUB_REF_NAME#v}`, and five `run:` lines expanded `${{ }}` (the version, the image digest, the registry path) straight into the shell. A tag like `v1$(id)` would have run as a command in the Docker Hub mirror step.

Now each job's "Extract version from tag" step runs `scripts/release-version.sh`, which refuses anything but a whole, strict semver tag before the version reaches a command, a registry path or `$GITHUB_OUTPUT`. Every value a `run:` block needs comes through `env:`. The Homebrew formula's "Get version" step sends the tag, the release's tag and the manual `workflow_dispatch` input through the same script, so a newline in the input can no longer write a second `version=` line. The refusals in `release-version.sh`, `wait-for-npm.sh` and `npm-tarball-sha256.sh` never echo the value, so a second line in it can't start its own `::` workflow command. `scripts/test-release-version.sh`, in the `fixtures` job, feeds the script command-carrying and multi-line tags, runs the real version steps from both workflows, and checks each bad value is refused with nothing in `$GITHUB_OUTPUT`.

Revert if a correct release tag is refused.
