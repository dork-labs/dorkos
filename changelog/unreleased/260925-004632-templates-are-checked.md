---
covers:
  - 'fix(agents): check what a template or marketplace agent brings before it lands (DOR-2325)'
---

### Security

- Creating an agent from the marketplace in the app now goes through the same checks as installing a package. What installs is exactly what its preview showed you, and a package that ships settings for its own sessions is refused. Before, the app copied the package's files without checking them. The agent now lives in its package's folder, so updates find it (DOR-2325)
- Creating an agent from your own template now shows you anything it brings that would run in the new agent's sessions before it is created: settings files with hooks or permission rules, servers, and skills that use tools without asking. You then decide whether to create it. In the terminal, `dorkos agent create --template` prints the same list and asks (DOR-2325)
- When an agent creates another agent from a template, a person now has to approve it on a card that lists everything the template brings. Before, nothing stopped it (DOR-2325)
