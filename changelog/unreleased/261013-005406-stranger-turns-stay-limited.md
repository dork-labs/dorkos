---
covers:
  - 'feat(trust): a turn a stranger started still posts and sends notes only a few times (DOR-2739)'
  - 'fix(trust): count only turns a stranger started, and only sends that went out (DOR-2739)'
---

### Changed

- When someone outside your team starts a turn, for example with a Telegram or Slack message, that turn can post at most three messages in rooms and send you at most three notes. Your own agents' turns are never counted. A Codex or OpenCode agent posting into a room other than the one it is answering is not counted yet (DOR-2739)
