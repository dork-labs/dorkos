---
covers:
  - 'fix(connections): an agent that asks to change things in an app hears plainly when it can only read (DOR-4193)'
---

### Fixed

- When an agent asks to read and change things in an app, it no longer hears "You can now read" as if that were everything. Its answer now says it can't change anything there, and why. Maybe you picked Read. Maybe the app has nothing to change. Or maybe the app's change actions are allowed one at a time, as with Linear today. (DOR-4193)
- Asking again for more access now always puts a card in front of you. Before, an agent that already had Read could be told it was done without you seeing anything. (DOR-4193)
- The access card now warns you before you answer when an app can only give Read. It says how to let the agent change things: choose exact actions on the Connections page. (DOR-3616, DOR-3021)
