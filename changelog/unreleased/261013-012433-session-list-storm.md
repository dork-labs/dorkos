---
covers:
  - 'fix: stop the chat-list storm that slowed the whole app'
---

### Fixed

- DorkOS no longer slows to a crawl while your agents are working. When any chat changed, every open window asked again for every agent's chats, and those requests piled up until switching tabs or agents took seconds and messages failed to send. The app now asks at most once every few seconds, and asks that arrive together share one answer.
