---
covers:
  - "fix(relay): a connection's secrets stay with that connection, and a new address needs them again (DOR-3271)"
  - 'fix(relay): exact secret names, no stored names from callers, and checks on the parsed edit (DOR-3271)'
  - 'fix(relay): only a person can give a connection an env: or keychain: secret (DOR-3271)'
  - 'fix(relay): person approvals live in the encrypted store, and stored names cannot collide (DOR-3271)'
  - 'fix(relay): a paused connection drops and counts, and its owner confirms exactly what it sends (DOR-3271)'
  - 'test(relay): the route census and shell mocks know the confirm routes and paused connections (DOR-3271)'
  - "fix(relay): only this install's owner confirms a paused connection or writes an env: or keychain: secret (DOR-3271)"
---

### Security

- A connection can only use the secrets saved for it. It can no longer point at another stored key, such as your Anthropic key, to send it somewhere else.

- Changing where a webhook sends messages now asks you to enter its secrets again, so saved secrets never follow a new address.

- Removing a connection deletes only its own saved secrets.

- A connection that sends an environment variable or Keychain item now pauses after this update until you confirm that setting, on the connection or in Needs you. Connections using saved secrets are unaffected. Messages are not sent while paused.
