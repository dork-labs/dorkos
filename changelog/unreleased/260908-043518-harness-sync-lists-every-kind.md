### Added

- `dorkos harness sync` now lists everything else in your `.claude/` folder, not just the parts it already knew how to copy. Your rules, your subagents, your MCP servers, the hooks you keep to yourself in `.claude/settings.local.json`, and any hooks a skill declares in its own front matter each get a line saying they stay in Claude Code — and, for every other agent you run, where that agent would keep the same thing. Before this, a project with 13 rules, 7 subagents and an `.mcp.json` was told about none of them, which reads exactly like a project that has none (DOR-1845)
- Your subagents already work in Cursor, and the report now says so: Cursor reads `.claude/agents/` itself. Nothing is written for it

### Fixed

- A `SKILL.md` whose front matter will not parse is now reported the same way every time. It used to be called broken the first time it was read and fine every time after that, so two parts of DorkOS could disagree about the same file depending on which one looked first (DOR-1845)
