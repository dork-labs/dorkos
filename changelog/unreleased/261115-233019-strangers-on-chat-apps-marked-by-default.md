---
covers:
  - 'fix(server): mark turns from people who are not the owner on Telegram, Slack and in rooms, by default (DOR-4453)'
---

### Security

- A message from someone else on Telegram, Slack or in a room now limits what your agent can do in that turn, even at **Full**. Before, it ran at its full level, so a stranger who could write in the chat could get it to send email or other messages for you. Now it can't send through a connected app in that turn, or raise a task's mode. In a chat that started on Telegram or Slack, nobody is there to approve, so those sends are refused (DOR-4453).
- **Check your approver list.** DorkOS knows a Telegram or Slack message is from you only when your own account is on that connection's approver list. If it isn't, your own messages are treated as someone else's, and your agent won't send for you from there. Open **Connections**, open the chat app's settings, and add your own account ID under **Approvers**.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now.
- To go back to the old behavior, set `DORKOS_MARK_STRANGER_TURNS=false` and restart DorkOS.
