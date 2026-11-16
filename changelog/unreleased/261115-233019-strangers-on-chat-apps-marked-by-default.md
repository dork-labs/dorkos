---
covers:
  - 'fix(server): mark turns from people who are not the owner on Telegram, Slack and in rooms, by default (DOR-4453)'
---

### Security

- A message from someone else on Telegram, Slack or in a room now limits what your agent can do in that turn, even at **Full**. Before, it ran at its full level, so a stranger who could write in the chat could get it to send email or other messages for you. Now a send through a connected app has to ask you first, and the agent can't raise a task above **Don't ask**. DorkOS can't ask you from a Telegram or Slack chat, so there the send is refused (DOR-4453).

### Note for people upgrading

- **Check your Approvers list.** DorkOS knows a Telegram or Slack message is from you only when your own ID is on that connection's **Approvers** list. If it isn't, your own messages count as someone else's, and your agent won't send through a connected app for you from there. Open **Connections**, open the chat app's settings, and add your ID under **Access Control**. If you can already message the bot privately, your ID is in the **DM Allowlist** right above it.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now.
- To go back to the old behavior, set `DORKOS_MARK_STRANGER_TURNS=false` and restart DorkOS.
