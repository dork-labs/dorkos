### Fixed

- Your Telegram bot no longer replies to other bots. If two bots that both answer messages ended up in the same group, they could talk to each other forever and fill the chat. Your bot now ignores anything another bot says, and there is no setting that turns this off.

### Changed

- **If you already have a Telegram bot in a group chat, it will now be quieter.** It used to reply to every single message. Now it replies when someone mentions it by name (`@yourbot`), when someone replies to one of its messages, and when someone sends it a command. It stays quiet the rest of the time.
- One-on-one chats have not changed. Your bot still replies to everything you send it directly.
- You can change this. Open Settings, go to Integrations, click Configure on your Telegram bot, and continue to the second step. Under "Replies in Groups", choose "Every message" to get the old behavior back.
- Anonymous group admins still get replies. Telegram sends their messages in a way that looks like a bot, but they are people, so your bot treats them like anyone else in the group.
