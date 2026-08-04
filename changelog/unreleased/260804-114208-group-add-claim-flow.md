---
covers:
  - 'feat(shared): platformChatType on the claim feed and a leaveUnclaimedChat transport method (DOR-883)'
  - 'feat(relay): detect a bot added to a Telegram group, and leave a chat on request (DOR-883)'
  - "feat(server): the group-add claim flow's Leave route and a titled group bridge (DOR-883)"
  - 'feat(client): Join, Ignore, and Leave for a group claim card; broadcast refusal (DOR-883)'
---

### Added

- Adding your bot to a Telegram group now shows up right away as its own card on the Connections page, naming who added it and to which group. Pick an agent and choose Join, and that agent answers the group from a new channel. Ignore hides the card without changing anything; Leave actually removes the bot from the group on Telegram, not just from the list. (DOR-883)
- If the bot gets added to a broadcast channel instead of a group, the card says so and only offers Ignore or Leave. A broadcast channel is one-way, so there is nobody in it for an agent to answer. (DOR-883, DOR-907)
