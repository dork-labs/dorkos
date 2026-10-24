---
covers:
  - "fix(relay): a connection's secrets stay with that connection, and a new address needs them again (DOR-3271)"
---

### Security

- A connection can only use the secrets saved for it. It can no longer point at another stored key, such as your Anthropic key, to send it somewhere else.

- Changing where a webhook sends messages now asks you to enter its secrets again, so saved secrets never follow a new address.

- Removing a connection deletes only its own saved secrets.
