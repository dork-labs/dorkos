---
covers:
  - 'fix(relay): chat integrations stay closed when consent cannot be resolved'
---

### Fixed

- "Let this agent start conversations here" is now a permission for that one agent on that one channel. Before, once you granted it, any agent on your machine could message that chat as your bot (DOR-788).
- If the part of DorkOS that decides who may message whom fails to start, chat integrations no longer start either. They used to connect, look healthy, and answer nobody — with the permission checks quietly switched off.
- If your relay access rules become unreadable, DorkOS now stops delivering and says which file to fix, instead of behaving as though you had never written a rule.
- One unreadable integration in your settings no longer hides all of them, and adding a new integration can no longer delete the ones DorkOS could not read.
- Group chats set to "a separate session per person" now really do give each person their own session. Everyone in the room was sharing one, so a conversation could be read by whoever spoke next.
- A message from a chat platform can no longer impersonate DorkOS's own instructions to your agent. Code and prose you paste into chat still arrive exactly as written.
- Custom webhook headers are treated as secrets: stored encrypted, hidden when read back, and never written to a log. An API key put there used to sit in a plain settings file.
- A Telegram integration that loses its connection now reports the problem and reconnects, instead of retrying in silence forever while reporting itself connected.
- A webhook pointed back at DorkOS now stops after a few laps instead of talking to itself indefinitely. If your service answers DorkOS through the inbound endpoint, pass the `X-Relay-Hop-Count` and `X-Relay-Max-Hops` headers back unchanged.
