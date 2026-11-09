---
covers:
  - 'fix(chat): a chat message or a started chat carries the outside words its sender read'
---

### Fixed

- **An agent that read words from outside your team now passes that on when it messages another chat or starts one.** Before, an agent could read a stranger's message, then message another chat, and that chat could still rewrite its notes or ask you to take over your shared browser. Now the chat it wakes is held the same way the sender was: it can add notes but not change them, and it can't ask you to take over the shared browser. The same goes for a room post from a Telegram or Slack chat, and for a spin-off's report back to the room it came from.
