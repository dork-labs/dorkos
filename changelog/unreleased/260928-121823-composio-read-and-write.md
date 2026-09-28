---
covers:
  - 'feat(connections): give Composio apps a real "Read and write" level (DOR-2466)'
  - 'fix(connections): classify Composio actions by their safety hints only (DOR-2466)'
---

### Added

- Apps you connect through Composio, such as Gmail, can now be shared as "Read and write" instead of only "Read". With it, agents can send, create and edit things, like sending an email or adding a calendar event. Agents still can't delete anything: you allow deleting one action at a time. "Read" also now covers reads that used to need your approval one at a time, such as reading a draft or finding free time in your calendar. No agent's access grows on its own (DOR-2466)
