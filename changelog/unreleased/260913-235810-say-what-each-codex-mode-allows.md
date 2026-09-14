---
covers:
  - 'feat(client): say plainly what each mode lets Codex do'
---

### Changed

- Codex sessions now say what the permission setting lets Codex do, in plain words. The default setting lets Codex read files but not change them, and Codex has no way to ask you to approve one, so asking for a change used to get a confusing "I can't do that" with nothing on screen to answer. A Codex session that starts in that setting now says so once, above the chat box, with a link to the picker. The three Codex settings read the same way wherever they appear (DOR-2019)
