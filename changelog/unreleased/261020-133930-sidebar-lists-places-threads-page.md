---
covers:
  - 'feat(threads): a Threads page lists every thread you are in, newest reply first (DOR-3078)'
  - 'feat(rooms): on a phone a thread opens as a full-screen sheet over its room (DOR-3078)'
  - 'feat(sidebar): the sidebar lists places: Threads, Directory, channels and direct messages (DOR-3092)'
---

### Added

- A Threads page lists every thread you are in, newest reply first. Each one shows its room, the message it started from and the two newest replies, and you can answer right there (DOR-3078)
- On a phone, a thread opens full screen over its room, with the first message pinned at the top. Tap back or swipe right, and you are where you were in the room (DOR-3078)

### Changed

- The sidebar now lists places, never single chats or threads. From the top: your workspace and New, a search box, Threads and Directory, your sections, Channels, Direct messages and Add-ons (DOR-3092)
- An agent shows up in Direct messages once you have messaged it or pinned it, and clicking it opens your chat with it. Every other agent is in the Directory
- A "Message an agent or person" row at the end of Direct messages opens the Directory to pick someone
- On a phone there are three tabs: Home, DorkBot and You. Home holds the whole list, with anything waiting on you as a card at the top

### Removed

- Heads up, Today and the Agents list are gone from the sidebar. Earlier chats are in ⌘K and on each agent's profile, threads are on the Threads page, approvals are in the Inbox, and scheduled runs are in Tasks and Activity
