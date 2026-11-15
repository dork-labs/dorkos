---
covers:
  - "fix(opencode): a project's own OpenCode plugins never run in the shared sidecar"
  - "fix(opencode): the project-plugins notice reads like the chat's other lasting notices"
  - "fix(opencode): the plugin guard looks all the way up and checks the session's stored folder"
---

### Fixed

- An OpenCode chat in a project that has its own OpenCode plugins no longer runs them. DorkOS doesn't send the message, and the chat says why. Your own plugins in `~/.config/opencode` keep working, and a way to allow a project's plugins is coming.
