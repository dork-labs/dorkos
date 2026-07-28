---
covers:
  - 'fix(approvals): an agent holding an API key can no longer approve its own destructive action (DOR-474)'
---

### Security

- Close a hole where an agent could approve its own risky action. When Require login is on, saying yes or no to an approval now has to come from a person signed in to DorkOS in their browser. Before this, an agent that found one of your API keys could answer its own request and go ahead with something it should have had to ask you about (DOR-474)

### Changed

- With Require login on, answering an approval from a script or the terminal is refused, and DorkOS says why. Approvals are answered in the DorkOS window. Everything else you run from the terminal, like installing and removing packages or creating tasks, works exactly as before
