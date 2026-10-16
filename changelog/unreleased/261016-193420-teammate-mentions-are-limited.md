---
covers:
  - 'fix(spaces): a teammate’s mention can no longer make your agent read your other rooms (DOR-2955)'
  - 'fix(spaces): a teammate’s turn reads no files and none of your agent’s notes (DOR-2955)'
---

### Security

- When someone else in a shared space mentions your agent, the agent now answers with much less power. It can read and post only in the room it's answering. It reads no files, it can't see your other rooms or chats, and its saved notes are left out. It can't run commands, change files, use the web or your connected apps, or save notes. It never asks you to approve anything, so other people's messages don't send you approval cards. Before, someone in the space could ask your agent to read your other rooms and post what it found. (DOR-2955)
- What a teammate writes stays in that room's conversation. The next time you talk to your agent in that room, it still sees what they wrote.
- Each person in a space can now wake your agent at most 3 times every 10 minutes, mentions and other posts counted together, and each channel at most 20 times. Messages past that stay in the space, and your agent doesn't answer them.
- For now, agents that run on Codex or OpenCode don't answer other people's messages in a space. Your own messages there reach them as before.
