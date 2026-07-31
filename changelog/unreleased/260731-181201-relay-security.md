---
covers:
  - 'fix(relay): chat integrations stay closed when consent cannot be resolved'
  - 'fix(relay): Telegram private chats need an allowlist, like Slack DMs'
  - "fix(relay): close the review's two blockers on unreadable entries and headers"
---

### Fixed

- Telegram private chats now use an allowlist, the same way Slack DMs do. A bot handle is public, and a private message starts a real agent turn on your machine, so a new integration answers only the people you name. If a message is ever turned away, the log says who it was, their user ID, and the setting to change (DOR-788).
- **A Telegram bot you already set up still answers anyone who messages it.** Changing that automatically would have taken a working bot off the air, so the old behaviour is kept and DorkOS warns about it by name at every startup. Open that integration, set **DM Access** to "Allowlist only", and add the people you want.
- Slack says the same thing out loud. Turning someone away used to be silent, which looks identical to a broken bot — especially right after setup, when the allowlist is still empty. It is now one clear line per conversation, not one per message.
- "Let this agent start conversations here" is now a permission for that one agent on that one channel. Before, once you granted it, any agent on your machine could message that chat as your bot.
- If the part of DorkOS that decides who may message whom fails to start, chat integrations no longer start either. They used to connect, look healthy, and answer nobody — with the permission checks quietly switched off.
- If your relay access rules become unreadable, DorkOS now stops delivering and says which file to fix, instead of behaving as though you had never written a rule.
- One unreadable integration in your settings no longer hides all of them, and adding a new integration can no longer delete the ones DorkOS could not read. An unreadable one is kept exactly as written — so if it holds a password, that password stays in plain text until you fix or delete it, and DorkOS now says so. You can delete it by name, and re-creating an integration under the same name clears the broken copy.
- Group chats set to "a separate session per person" now really do give each person their own session. Everyone in the room was sharing one, so a conversation could be read by whoever spoke next.
- A message from a chat platform can no longer impersonate DorkOS's own instructions to your agent. Code and prose you paste into chat still arrive exactly as written.
- Custom webhook headers can be set at all now — saving them used to fail every time — and they are treated as secrets: stored encrypted, hidden when read back, and never written to a log. An API key put there used to sit in a plain settings file (DOR-796).
- A Telegram integration that loses its connection now reports the problem and reconnects, instead of retrying in silence forever while reporting itself connected.
- A webhook pointed back at DorkOS now stops after a few laps instead of talking to itself indefinitely. If your service answers DorkOS through the inbound endpoint, pass the `X-Relay-Hop-Count` and `X-Relay-Max-Hops` headers back unchanged.
