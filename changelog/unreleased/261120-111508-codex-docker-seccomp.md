---
covers:
  - "fix(docker): ship a seccomp profile that lets Codex's sandbox start (DOR-3800)"
---

### Fixed

- Codex now starts in the Docker image on Docker Desktop for Mac when you run it with the profile DorkOS ships. Docker's standard settings stopped Codex before it ran anything. The profile is opt-in and adds no capabilities, and the Docker guide shows the one line to add (DOR-3800)
- When Docker blocks Codex's sandbox, the chat now says so plainly, instead of asking you to send your message again. Codex still never runs without its sandbox (DOR-3800)

### Note for people upgrading

- Codex in Docker doesn't work on Ubuntu or Debian yet, even with the profile: their AppArmor rules block the sandbox. The chat says "Codex can’t run in this Docker setup yet", and the server log shows "bwrap: Failed to make / slave: Permission denied". There is no safe workaround yet, so leave AppArmor as it is, and use Claude Code or run DorkOS outside Docker. Support is planned (DOR-4836)
