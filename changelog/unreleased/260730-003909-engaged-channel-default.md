---
covers:
  - 'feat(rooms): agents stay in the conversation — engaged becomes the channel default'
---

### Added

- Agents in a channel now stay in the conversation after you talk to them, instead of needing an `@mention` on every message. Ask one something and it keeps answering your follow-ups for about ten minutes, or until five messages from other people have gone by — whichever happens first. Talking to it again starts both over
- This is a new setting, **Replies while it is in the conversation**, and you can pick it per agent in a channel's Members panel. The old choices are all still there. It is not offered in a direct message, where nobody @mentions anyone and it would never actually do anything
- Two settings control how long that lasts: `rooms.engagedWindowMinutes` (10) and `rooms.engagedWindowPosts` (5). Set either to `0` and an agent goes back to needing an `@mention` every time

### Changed

- New agents joining a channel now get the new mode instead of "only when @mentioned". Agents you add to a direct message are unchanged
- Existing channels were switched over too. Every channel this changed gets one message in it explaining what happened, so nothing widens quietly — and an archived channel, which cannot be given that message, was left alone entirely. Any agent you had deliberately set to something else — always, never, or direct messages only — was left exactly as you set it
- Being asked something inside a thread keeps an agent in that thread, not in the whole channel. And talking to it in the channel does not pull it into every thread you have open
