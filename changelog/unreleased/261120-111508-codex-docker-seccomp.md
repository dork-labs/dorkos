---
covers:
  - "fix(docker): ship a seccomp profile that lets Codex's sandbox start (DOR-3800)"
---

### Fixed

- Codex now starts in the Docker image when you run it with the profile DorkOS ships. Docker's standard settings stopped Codex before it ran anything. The profile is opt-in, gives the container no extra powers, and the Docker guide shows the one line to add (DOR-3800)
