---
covers:
  - 'fix: stop the chat-list storm that slowed the whole app'
  - 'fix: never hand a caller a scan from before a chat changed'
  - 'chore: fold the review fix into the chat-list storm changelog fragment'
---

### Fixed

- DorkOS no longer slows to a crawl while your agents are working. When any chat changed, every open window asked again for every agent's chats, and those requests piled up until switching tabs or agents took seconds and messages failed to send. The app now asks at most once every few seconds, asks that arrive together share one answer, and a new chat still shows up in your recent chats right away.
