---
covers:
  - 'feat(session): agents can ask to summarize their own chat (DOR-2732)'
  - "fix(session): close the review's gaps in agent-requested compaction (DOR-2732)"
  - 'chore(changelog): cover the compaction review fixes (DOR-2732)'
  - 'fix(session): show the percent on a first-turn summary, keep the ceiling (DOR-2732)'
  - 'chore(changelog): fold the first-turn percent fix into the fragment (DOR-2732)'
---

### Added

- An agent whose chat is nearly full can now ask for it to be summarized, instead of waiting for you to type `/compact`. The summary happens after its current reply ends, never in the middle of one, and the chat shows a line like "Summarized at 89% (asked by the agent)". An agent can ask at most once an hour, and only for its own chat. You can turn this off for any agent on its Permissions page, under Own chat. Works in Claude Code, Codex and OpenCode (DOR-2732)
- When a chat passes 80% of its room, the agent gets one short note on its next reply suggesting it save its notes and ask for a summary. It is told once, and again only after the chat has been summarized. This works in Claude Code, Codex and OpenCode (DOR-2732)
