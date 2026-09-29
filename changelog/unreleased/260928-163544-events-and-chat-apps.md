---
covers:
  - 'fix(connections): keep app notifications in one chat, show when they fail, and turn chat apps on from the app (DOR-2507)'
  - 'fix(connections): let the chat apps switch work on CLI installs, and give every notification problem a next step (DOR-2507)'
  - 'fix(connections): start a new notification chat once its permission level is raised (DOR-2507)'
  - 'fix(client): use the shared Spinner for a removing notification'
---

### Changed

- Notifications from an app now go to one chat with the agent. Before, every new email or event opened a brand-new chat, so a busy inbox buried your chat list. Each message in that chat starts with the kind of notification it is, like "New email: Invoice from Acme". If you change that chat's permission level for your own messages, the next notification starts a new chat, so a notification never runs with more power than you approved for it. (DOR-2507)
- You can turn on chat apps (Telegram, Slack and webhooks) from the Connections page. Before, you had to quit DorkOS and start it again from a terminal with a special setting, which the desktop app had no way to do. Now you choose Turn on chat apps, then Restart DorkOS. The terminal setting still works and still wins if you use it. (DOR-2507)

### Fixed

- Each notification now says how its newest event went: delivered, on its way, being tried again, or what stopped it and what to do next. Before, a notification that failed looked exactly like one that worked. A notification sent to an agent has an Open chat button. (DOR-2507)
- You can remove any notification, including ones that stopped working. Before, a notification that stopped stayed on the list forever with no way to remove it, and a removed one stayed listed as "revoked". (DOR-2507)
- Notifications are described in plain words: who they go to, and what they filter on ("Only when Folder is inbox"). Raw codes, ids and filter code no longer show. (DOR-2507)
- An account that can't send notifications says so once, instead of showing a setup box plus a second error. An account connected through your DorkOS account no longer claims delivery is taken care of before its notifications actually load. (DOR-2507)
