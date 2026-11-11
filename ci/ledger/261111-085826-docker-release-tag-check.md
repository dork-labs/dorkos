---
id: 261111-085826
title: "The Docker release jobs refuse a tag that isn't a plain release, and pass every run: value through env"
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.publish-docker.build-and-push
  - wf.publish-docker.build-and-push-hub
  - wf.publish-docker.mirror-docker-hub
prs: []
ratchet-release: []
field-changes: []
---

A safety fix, not an experiment: nothing measurable should move on a real release (DOR-4175). Every job in `publish-docker.yml` took its version from the pushed tag name with `${GITHUB_REF_NAME#v}`, and five `run:` lines expanded `${{ }}` (the version, the image digest, the registry path) straight into the shell. A tag like `v1$(id)` would have run as a command in the Docker Hub mirror step.

Now each job's "Extract version from tag" step runs `scripts/release-version.sh`, which refuses anything but a whole, strict semver tag before the version reaches a command, a registry path or `$GITHUB_OUTPUT`. Every value a `run:` block needs comes through `env:`. `scripts/test-release-version.sh`, in the `fixtures` job, feeds it command-carrying and multi-line tags, checks each is refused before the command inside runs, and checks the workflow keeps both rules.

Revert if a correct release tag is refused.
