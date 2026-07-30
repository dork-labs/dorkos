---
covers:
  - 'fix(connectors): accept both Composio key kinds — x-user-api-key routing + project resolution (DOR-736 follow-up)'
---

### Fixed

- Your Composio key works now, whichever kind you have. Project keys and the account key the composio command-line tool signs in with both connect — DorkOS figures out which kind you pasted, and the provider card tells you which one it's using
