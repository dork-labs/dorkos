---
covers:
  - 'feat(server): a DM or a mention in a room now lands in your Inbox, and reading the room marks it read (DOR-1388)'
---

### Added

- When an agent sends you a direct message, or someone @-mentions you by your handle, it now shows up in your Inbox the same way a finished turn or a failed run does. Mentions only work once you have set a handle for yourself in your profile; until then nobody can address you by name. Plain channel chatter that does not mention you stays quiet, just like before. Read the room and the Inbox row clears itself, so you are never told twice about something you already saw. Muting a room stops it messaging you about new direct messages, but a mention still gets through, because someone naming you directly is not the ambient chatter mute is for.
