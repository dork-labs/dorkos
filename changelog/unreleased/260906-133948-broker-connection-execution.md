---
covers:
  - 'feat(connectors): enforce brokered execution across DorkOS'
---

### Added

- Review the exact connected account and actions each named agent can use in Connections.
- Use approved Composio actions from Claude Code, Codex, OpenCode, or the `dorkos connections` command.
- Let programs request a connection change and follow its status without gaining owner access.
- Show an explicit unknown outcome when an approved change may have finished but its confirmation could not be saved.

### Security

- Check the active turn, agent, session override, connection, action version, and approval again before every provider attempt.
- Stop the next discovery or action after access is revoked, a turn ends, or provider configuration changes.
