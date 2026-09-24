---
covers:
  - 'feat(marketplace): let agents check for and install package updates, bound to what each new version runs (DOR-2195)'
---

### Added

- Your agents can now find out which of your installed packages have a newer version, and update them. Ask an agent "is anything out of date?" and it can check every package you have installed, in every place it is installed, without opening the app. When you want the updates, the agent asks first: an approval card lists every package it would update, where it is, the old and new version, and every command, scheduled job and MCP server the new version would run. Nothing changes until you say yes, and if a package changes after you approve it, that package is not updated and you are asked again. A package you linked from your own working copy is never replaced. Agents can also ask for an out-of-date flag on the list of installed packages they already read, and that list stays as fast as before when they don't ask (DOR-2195).
- Before you install a plugin, DorkOS now shows every program it would start on its own: MCP servers, language servers, background monitors, and the commands it adds for your agents to run, each with exactly what it runs. It also reads hooks a plugin declares in its manifest or in its skills, not only in its hooks file, shows the tools each skill may use without asking you, and says so when a plugin declares something it can't read. The app, `dorkos install`, and agent approvals all list these, hidden characters that could disguise a command are shown, and an approval no longer covers a package that adds or changes one after you said yes (DOR-2195).
