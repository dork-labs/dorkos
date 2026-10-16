---
covers:
  - 'fix(spaces): a teammate’s mention can no longer make your agent read your other rooms (DOR-2955)'
---

### Security

- When someone else in a shared space mentions your agent, the agent now answers with less power. It can read the files in its own folder, and read and post in that one room. It can't read your other rooms or chats, run commands, change files, use the web or your connected apps, or save notes. It also can't ask you to approve anything, so no approval cards come from other people's messages. Before, someone in the space could ask your agent to read your other rooms and post what it found. (DOR-2955)
- Each person in a space can now wake your agent at most 3 times every 10 minutes, and each channel at most 20 times. Messages past that stay in the space, and your agent doesn't answer them.
- For now, agents that run on Codex or OpenCode don't answer other people's messages in a space. Your own messages there reach them as before.
