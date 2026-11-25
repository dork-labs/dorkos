---
covers:
  - "fix(api): a person's to-do writes and promise changes are served by the capability mount, person-held from Wi-Fi (DOR-4978)"
---

### Changed

- Making or changing a to-do, and closing, moving or confirming an agent's promise, now works only for you in the app.
- Once you have an owner account, a program on this computer that isn't signed in as you gets `person_only` and writes nothing. Before, it could make a to-do with the lowest power.
- Any request that sends an `Authorization` header gets `person_only` too. That includes your own API key, which before could close or move a promise.
- On a computer with no owner account, nothing changes.
- From a phone or another device on your Wi-Fi, these work as before. On a device you didn't let run agents, it works as it did before: you can finish, reopen, note or reorder your own to-dos.
- An agent that tries one still gets `person_only`, with the same hint as before about which tool to use instead.
- For API users: four operation ids changed. `todos.create` is now `todos.add_as_person`, `todos.update` is now `todos.change_as_person`, `todoPromises.update` is now `todos.change_promise`, and `todoPromises.confirm` is now `todos.confirm_promise`.
