---
covers:
  - 'feat(server): Codex conversations join the searchable copy of your history (DOR-683)'
---

### Added

- The searchable copy of your chats now covers your **Codex** conversations too — live ones and ones you archived. DorkOS reads the files Codex already writes, so chats you had in DorkOS and chats you had in the plain `codex` terminal are both in there. You can search these from the search box (⌘⇧F) (DOR-683)
- Only what was actually said gets saved: your words and the agent's replies. The setup text Codex and DorkOS slip into a message before sending it — the project notes, the environment block, the widget instructions — is left out, so searching does not turn up things nobody said (DOR-683)
- Codex records every message twice in its own files, once for the model and once for the on-screen log. DorkOS reads one of the two, so a chat you had once shows up once (DOR-683)
- If Codex has never run on your computer, this quietly finds nothing and says nothing (DOR-683)
