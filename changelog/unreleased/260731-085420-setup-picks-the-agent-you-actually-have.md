---
covers:
  - 'feat(onboarding): setup picks the agent you actually have, and says so'
---

### Changed

- **First-run setup now points new chats at the coding agent you actually have.** If Codex is the only one connected when the setup check finishes, DorkOS starts new chats with Codex instead of quietly assuming Claude Code. The sentence on that screen says which one it picked — "Codex is connected. New chats will start with it." — and a **Change** link right under it switches to any other agent in one tap — including one you have not connected yet, in which case the screen tells you which agent your chats will use in the meantime.
- It waits for the check to finish rather than deciding the moment DorkOS opens, because you can connect an agent from that very screen and the answer changes when you do.
- **The pick happens once, on your first run, and never again.** Reopening setup, refreshing halfway through, or installing another coding agent later will not move the setting behind your back. From then on it is yours, and Settings → Runtimes is where you change it.
