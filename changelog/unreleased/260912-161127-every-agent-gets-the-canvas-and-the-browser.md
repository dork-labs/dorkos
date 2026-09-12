---
covers:
  - 'feat(ui): move the canvas and browser verbs onto the capability registry (DOR-2009)'
  - 'test(ui): prove the seat on every runtime, and pin what each verb advertises (DOR-2009)'
  - 'docs(ui): say that Codex and OpenCode get the canvas and the browser too (DOR-2009)'
---

### Added

- Your Codex and OpenCode agents can now use the canvas and the browser the same way your Claude Code agents always have. They can put a document up, open a file or a diff beside your chat, point the Browser tab at a page, read its console and its network log, take a screenshot, use the page — click, type, scroll, wait for something — and record what they did. Turn on **DorkOS tools for Codex and OpenCode** in Settings under Experiments, and their next turn has all of it. Until now a Codex agent in a room could not see a console error while the Claude Code agent beside it could (DOR-2009).

### Fixed

- Asking an agent for the console at a particular level, or for only the failed requests, works again. Both reads were quietly ignoring every filter you gave them and answering with the default instead (DOR-2009).

### Note for people upgrading

- One thing an agent reaching in from outside the DorkOS app still cannot do: apply a Shape. It writes to your machine — files, settings and scheduled work — and there is no way to put that question to you from a Codex or OpenCode session, so it is refused with a sentence telling the agent to ask you to do it in the app. Your Claude Code agents still ask you the normal way.
- Nothing changed about what your Claude Code agents can do, or what any of these tools are called. They are the same names, the same arguments and the same answers; there is just one copy of each now instead of one per runtime.
