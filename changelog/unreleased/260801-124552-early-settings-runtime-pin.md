---
covers:
  - 'fix(session): an early settings write no longer pins a session to the wrong runtime'
---

### Fixed

- **Changing a setting before you send the first message no longer decides which agent runtime the chat runs on.** If you picked Codex or OpenCode for a new chat and then adjusted the model, effort or trust level before typing anything, DorkOS quietly filed the chat as Claude Code — and that stuck, because a chat's runtime is set once and never changes. Now the choice you made in the picker is what counts: the settings you change beforehand are saved on their own, and the chat is tied to a runtime when you actually start it.
- **The defaults a new chat starts with come from the runtime it really runs on.** A model, an effort and a trust level only mean something inside one runtime, so DorkOS no longer fills them in before it knows which one you meant. Anything you chose yourself is kept exactly as you set it; only the settings you left alone are filled in, at the moment the chat starts.
- **A trust level you picked before starting is checked against the runtime you actually start on.** Every runtime offers a different set — so if the one you picked beforehand isn't among them, the chat starts at that runtime's own setting rather than claiming a level it is not running. A level the runtime does offer is yours, and is kept.
