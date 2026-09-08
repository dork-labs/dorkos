---
covers:
  - 'fix(skills): a broken SKILL.md reads broken every time (DOR-1845)'
  - 'feat(harness): count everything a person authored, not only what projects (DOR-1845)'
  - 'feat(harness): every kind in .claude/ is listed, and none stays silent (DOR-1845)'
  - 'docs(harness): say what the sync now lists (DOR-1845)'
  - 'docs(contributing): how the source inventory and its reason tables work (DOR-1845)'
  - 'fix(skills): the gray-matter cache trap is closed at both call sites (DOR-1845)'
  - 'fix(harness): the inventory walks what the harness reads (DOR-1845)'
  - 'fix(harness): a drop names the file it is about, and the facts decide who reads it (DOR-1845)'
  - 'test(harness): the generator stages the shapes that were silent (DOR-1845)'
  - "docs(harness): the contract's resolved cells, and the traps behind them (DOR-1845)"
---

### Added

- `dorkos harness sync` now lists everything else in your `.claude/` folder, not just the parts it already knew how to copy. Rules in subfolders, subagents in subfolders, and whole folders you have linked in from elsewhere are all counted, and a subagent is listed under the name you invoke it by rather than its file path. Your rules, your subagents, your MCP servers, the hooks you keep to yourself in `.claude/settings.local.json`, and any hooks a skill declares in its own front matter each get a line saying they stay in Claude Code — and, for every other agent you run, where that agent would keep the same thing. Before this, a project with 13 rules, 7 subagents and an `.mcp.json` was told about none of them, which reads exactly like a project that has none (DOR-1845)
- Your subagents already work in Cursor, and your skills in `.claude/skills` already work in Cursor, OpenCode and Copilot — the report now says so instead of calling them dropped. All four read those folders themselves, so nothing is written for them

### Fixed

- A `SKILL.md` whose front matter will not parse is now reported the same way every time, by every part of DorkOS that reads one. It used to be called broken the first time it was opened in a session and something else entirely after that, so which answer you got depended on which reader looked first — the marketplace preview, a scheduled task, the skills list, or the harness report (DOR-1845)
