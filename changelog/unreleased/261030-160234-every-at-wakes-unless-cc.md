---
covers:
  - 'feat(rooms): every @ wakes the agent unless cc comes first, and a post says who it reached (DOR-3453, DOR-3454)'
---

### Changed

- In a channel, every @name in a message now wakes that agent, wherever it sits. To keep an agent posted without asking it to act, write `cc` before its name: "cc @ana @bo" wakes neither, for the rest of that line. Before, only the names at the start of a message woke anyone, so a message that answered a person and then gave agents work woke none of them. Direct messages work as before.
- Your own channel messages now say who they reached, like "Woke @ana. Cc: @bo." Agents get the same line back when they post, so a name that only got a copy is caught straight away. While you type, the line under the box reads "Wakes @ana · cc @bo".
