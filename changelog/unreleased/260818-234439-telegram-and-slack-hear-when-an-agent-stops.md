---
covers:
  - 'feat(server): a bridged chat hears when an agent is waiting on you or is already busy (DOR-1359)'
---

### Added

- If you talk to an agent from Telegram or Slack, you now hear when it stops. Before, only two things reached you: a reply that crashed, and somebody pressing Stop. If the agent paused to ask you to approve something, or was already busy with other work and never picked your message up, nothing was sent — so from the chat it just looked like the agent had gone quiet, sometimes for a long time. Both of those now arrive as a short message, in the same plain words the agent's own conversation in DorkOS uses. You still answer an approval in DorkOS itself; the chat message only tells you there is something waiting, and never includes what the agent wanted to run. Nothing changes for group chats, which stay quiet by default, and each pause is reported once, not once per message. (DOR-1359)
