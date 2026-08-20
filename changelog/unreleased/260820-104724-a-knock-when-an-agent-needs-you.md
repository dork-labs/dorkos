---
covers:
  - 'feat(client,server,shared): a knock when an agent needs you, and one place to set how loud DorkOS is (DOR-1385)'
---

### Added

- A soft knock now plays the moment an agent stops and needs you, and a gentle chime plays when the last thing waiting on you is answered. Both are on to start with.
- If the DorkOS tab is hidden behind something else, your browser can show a notification when an agent needs you, or when a turn finishes while you are away. Clicking it brings DorkOS back and opens the thing it is about. DorkOS asks for permission the first time that would actually be useful, never when you open it, and it only asks once.
- Settings has a new Notifications tab. Every sound, the browser notification setting, and how long something may wait before DorkOS tries to reach you another way now live together in one place.

### Changed

- The chime that used to play every time an agent finished replying is off to start with. With a few agents running it was a lot of sound, and it never told you which one needed you. You can turn it back on in Settings under Notifications.
- Sound settings follow you between devices now instead of being remembered by one browser. If you had the finishing chime turned on, it stays on.
- The sound switch inside a conversation's status panel is gone. It looked like it was about that one conversation and was not, and all three sounds are now set together in Settings.
