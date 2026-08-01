---
covers:
  - 'feat(permissions): the consent door covers every mode that never asks (DOR-816)'
---

### Changed

- **Any setting that stops the asking now asks you first — not just Full autonomy.** Some agents cannot pause mid-turn to ask permission. On those, the middle setting ("Act") still edits files and runs commands in your project, it just never checks with you first. Until now only the top setting stopped to confirm, so you could land in a mode that asks nothing without ever being told. Now DorkOS confirms before it turns on any setting that will not stop to ask and can do more than read — in a chat, on a chat integration, and on a scheduled task alike.

  The confirmation says what is true of the setting you picked rather than borrowing the loudest words: it keeps the name you pressed, adds the one sentence that matters ("This stop never pauses to ask. Whatever it decides to do, it does."), and shows your agent's own description underneath. It also carries the line that was previously only shown for Full autonomy — that this covers tools inside the chat, and DorkOS's own actions, like removing a package, still ask you. A read-only setting is left alone: it never asks because there is nothing to ask about, and a confirmation in front of the safest choice is how confirmations stop being read.

  If you have already ticked **Don't show this again**, nothing changes: that one answer covers all of it, and you can bring the question back any time from Settings.
