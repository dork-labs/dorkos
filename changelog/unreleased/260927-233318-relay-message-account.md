---
covers:
  - 'Let a relay message name the account a new conversation runs on (DOR-2384)'
---

### Added

- When one agent messages another to start a new conversation, it can ask for that conversation to run on a particular Claude account. DorkOS only honors the request when Flow's account settings allow it. Otherwise the message is still delivered and runs on the usual account, and a conversation that has already started always stays on its own account (DOR-2384).
