---
covers:
  - 'fix(server): stranger marks cover what a room turn was shown, and refuse every typed secret from a marked agent (DOR-4453)'
  - "fix(server): a marked agent can't move a connection's saved secrets, and pin the aside and context guards (DOR-4453 review)"
  - 'fix(server): mark turns from people who are not the owner on Telegram, Slack and in rooms, by default (DOR-4453)'
  - 'fix(server): stranger-mark review fixes: dev off switch, tests the flip broke, Approvers help and copy (DOR-4453)'
  - 'fix(rooms): a bridged group’s far-end title no longer reaches the agent until the owner renames the room (DOR-4453)'
---

### Security

- A message from someone else on Telegram, Slack or in a room now limits what your agent can do in that turn, even at **Full**. Before, it ran at its full level, so a stranger who could write in the chat could get it to send email or other messages for you. Now a send through a connected app has to ask you first, and the agent can't raise a task above **Don't ask**. DorkOS can't ask you from a Telegram or Slack chat, so there the send is refused (DOR-4453).
- In a room, a message from someone else marks the turn even when it only sits in what your agent reads, not just when it names your agent.
- An agent in a marked turn can't type a password or key into a chat app's settings, or move saved ones to a new address. A person has to enter them.
- Anyone in a Telegram or Slack group can change its name, so your agent no longer sees that name. It calls the room "Bridged channel" until you rename the room in DorkOS.

### Note for people upgrading

- **Check your Approvers list.** DorkOS knows a Telegram or Slack message is from you only when your own ID is on that connection's **Approvers** list. If it isn't, your own messages count as someone else's, and your agent won't send through a connected app for you from there. Open **Connections**, open the chat app's settings, and add your ID under **Access Control**. If you can already message the bot privately, your ID is in the **DM Allowlist** right above it.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now.
- To go back to the old behavior, set `DORKOS_MARK_STRANGER_TURNS=false` and restart DorkOS.
