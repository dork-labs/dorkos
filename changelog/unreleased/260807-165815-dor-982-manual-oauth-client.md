---
covers:
  - 'feat(server): sign in to providers that need their own app registration (DOR-982)'
  - 'feat(client): a failed sign-in says what went wrong in plain words, and offers the fix (DOR-982)'
  - 'fix(client): a failed credentials save keeps the form, its input, and its focus (DOR-982)'
---

### Added

- Some services will not let DorkOS sign itself up automatically — they want you to register an
  app with them first and hand over the ID it gives you. That used to be a dead end. Now, if a
  sign-in fails for that reason, the server's card offers "Use your own app credentials": paste
  the ID (and the secret, if you got one) and sign in normally. What you paste is kept encrypted
  on this computer, the agent never sees it, and the card's Details afterwards says the server is
  using your own app credentials (DOR-982).

### Changed

- When a sign-in cannot get started, you now get a sentence you can act on instead of an OAuth
  error. "This server doesn't let DorkOS register itself." "This server doesn't offer sign-in the
  way DorkOS expects." "Couldn't reach the server." The exact technical error is still there,
  tucked behind Details for when you want it (DOR-982).
