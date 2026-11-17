---
covers:
  - 'fix(auth): confirm lasting access changes (DOR-4355)'
  - 'fix(auth): preserve confirmations and allow lower spending limits'
  - 'fix(auth): clean up refused space moves and declare the upload as binary'
  - 'fix(auth): confirm raising what agents may do and spend'
  - 'fix(auth): remove only the staged export a space move made'
  - 'fix(auth): treat choosing Careful as a raise when it would loosen anything'
  - 'fix(auth): refuse a preset move judged against permissions that changed'
---

### Security

- Confirm lasting access changes and signing out another device with your DorkOS password, at your desk or over Remote Access.
- Create and rename API keys over Remote Access after confirmation. Wi-Fi access keeps its existing limits.
- Confirm credits for agents, checks and scheduled tasks, space moves, and showing or replacing the local MCP token.
- Confirm raising what agents may do, raising or removing a space's limit on teammates' turns, and turning on an extension. Lowering stays instant.
