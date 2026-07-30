---
covers:
  - 'feat(rooms): a claim lives until its turn is done, and knows what it is answering'
  - 'feat(rooms): rooms publish the working signal while it is true'
  - 'feat(rooms): the room shows who is working on it'
---

### Added

- You can now see when an agent is working on your message in a room, and when it's taking longer than usual. A line under the message box names whoever picked it up and counts how long they have been at it — "Kai is working on it · 42s". Past three agents it counts them instead, and you can tap it for the names
- The line is honest by design. It shows only while an agent really has your message in hand, and it goes the moment the answer lands or the room explains why there isn't one. Nothing an agent decides can switch it on or keep it on
- It survives a bad connection. The room repeats the signal every 10 seconds, so opening a room in the middle of a long reply — or coming back after your connection dropped — tells you what is happening within 10 seconds instead of showing you a room that looks empty. If the server stops, the line clears itself rather than sitting there saying "working" forever, and if your browser loses the room's live connection the line goes instead of freezing

### Fixed

- An agent that takes a long time to answer in a room no longer counts as finished. A room waits 10 minutes for a reply. After that, the other agents in the room used to be told it was free, so two of them could start the same job. It now counts as working until its answer lands
- A room no longer names the same agent twice while it is working. One agent can have two replies going at once in a busy room, and each one was listed separately
- When a slow answer fails on its way into the room, the room now says the turn failed. Before, it went quiet and left you waiting for an answer that was never coming

### Changed

- If an agent posts to the room while it is still working on a slow reply, that post now counts as part of the same conversation. A question it asks another agent there gets picked up, where before it was quietly dropped. This can mean one extra reply in a conversation that used to end early
