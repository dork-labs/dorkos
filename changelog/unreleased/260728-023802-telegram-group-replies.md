### Fixed

- Your Telegram bot no longer replies to other bots. If two bots that both answer messages ended up in the same group, they could talk to each other forever and fill the chat. Your bot now ignores anything another bot says, and there is no setting that turns this off.

### Changed

- Your Telegram bot no longer answers every message in a group chat. It now replies when someone mentions it by name and when someone replies to one of its messages, which is how the Slack integration already worked. One-on-one chats are unchanged: the bot still answers everything you send it.
- You can pick the group behavior yourself in the Telegram integration settings, under "Replies in Groups". Choose "Every message" if you want the old behavior back.
