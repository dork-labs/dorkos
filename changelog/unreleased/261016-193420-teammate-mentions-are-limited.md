---
covers:
  - 'fix(spaces): a teammate’s mention can no longer make your agent read your other rooms (DOR-2955)'
  - 'fix(spaces): a teammate’s turn reads no files and none of your agent’s notes (DOR-2955)'
  - 'fix(rooms): someone else’s message can no longer run a command or open a file through your agent (DOR-2955)'
  - 'fix(rooms): an @ after any character can no longer open a file through your agent (DOR-2955)'
---

### Security

- When someone else in a shared space mentions your agent, the agent now answers with much less power. It can read and post only in the room it's answering. It reads no files, it can't see your other rooms or chats, and it doesn't see its saved notes, your CLAUDE.md files or Claude Code's own memory for its folder. It can't run commands, change files, use the web or your connected apps, or save notes. It never asks you to approve anything, so other people's messages don't send you approval cards. Before, someone in the space could ask your agent to read your other rooms and post what it found. (DOR-2955)
- What a teammate writes stays in that room's conversation. The next time you talk to your agent in that room, it still sees what they wrote.
- Each person in a space can now wake your agent at most 3 times every 10 minutes, mentions and other posts counted together, and each channel at most 20 times. Messages past that stay in the space, and your agent doesn't answer them.
- In any room, a Claude Code agent no longer runs a command or opens a file because of what someone else wrote. A `/command` or an `@file` in a message from a Telegram or Slack chat linked to a room, from a shared space, or from another agent now reaches the agent as plain text. A message you type yourself in the app still runs commands and opens files as before. Two exceptions: your own post that arrives through a shared space, and your message when the agent answers it together with someone else's in one go, also reach it as plain text.
- For now, agents that run on Codex or OpenCode don't answer other people's messages in a space. Your own messages there reach them as before.
