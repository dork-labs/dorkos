---
covers:
  - "fix(server): the owner's own messages from Wi-Fi run at the agent's level (DOR-3242)"
  - 'fix(server): a Full chat keeps its 60-second window while Wi-Fi is open (DOR-3242)'
---

### Changed

- Your own messages from Wi-Fi no longer make agents ask you to approve their commands. When you're signed in as the owner on your phone over Wi-Fi, a message, room post, answer or button press now counts as yours, the same as at your computer. Anyone else on Wi-Fi is still held back, as before. From Wi-Fi you still can't raise an agent's permissions or change how DorkOS is reached. And while Wi-Fi access is on, an agent's action in a connected app that can't be undone, like sending an email, asks you first, and the card says why. You can't say yes to it from Wi-Fi. A chat set to Full autonomy is the exception: it never asks, and its action waits 60 seconds that anyone else can cancel, as it does with Wi-Fi off.
