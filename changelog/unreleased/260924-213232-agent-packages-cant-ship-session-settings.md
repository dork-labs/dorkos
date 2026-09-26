---
covers:
  - "fix(client): spell the refusal notice's apostrophe the house way (DOR-2314)"
  - 'fix(marketplace): refuse nested .claude folders, deep or non-YAML subagents and Gemini settings in agent packages, and block agent creation on a refused package (DOR-2314)'
  - 'fix(marketplace): an agent package can no longer ship settings for its own sessions, and its skills are on the install screen (DOR-2314)'
---

### Security

- An agent package installs into the folder its sessions run in, so settings it shipped there could run commands, start servers or let the agent act without asking, and none of it was on the install screen. DorkOS now refuses an agent package that ships them: Claude Code's `.claude/settings.json` (or a `.claude` folder anywhere below the top), a `.mcp.json`, a subagent with its own hooks or servers, Codex's `.codex/` folder, OpenCode's `opencode.json` or `.opencode/` folder, and Gemini CLI's settings. Instructions and skills are still fine, and the install screen now lists what the skills in those folders may do without asking. This covers `dorkos install`, installs by an agent, and installs through DorkOS's own connections (DOR-2314)
- In the app, a marketplace agent can no longer be created when DorkOS refuses its package: the card says why and **Create** stays off. The app still copies an agent package its own way, which skips some of these checks; that is being fixed separately (DOR-2325) (DOR-2314)
- When DorkOS won't install a package, the install screen and the package page now say so and why, instead of showing "No special permissions required" (DOR-2314)
- A package can no longer mark those settings folders as yours to edit, so an update always runs exactly what you approved (DOR-2314)
