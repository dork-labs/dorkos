---
covers:
  - 'feat(permissions): give every action its area, let config_patch ask in a floor area, and add change_permission'
  - 'feat(permissions): retire the tier ceiling and the tool-group context switches'
  - 'feat(permissions): presets set the Files & commands stop, and each agent can have its own'
  - 'feat(cli): add dorkos permissions and dorkos agent permissions'
  - 'feat(permissions): the preset picker, every area, individual actions and Files & commands in the app'
  - 'fix(permissions): decide a config patch by the strictest area it reaches'
  - 'fix(cli): check an action id before changing it, and fix the example'
  - 'fix(permissions): count an unset Files & commands stop as a change from the preset'
  - 'fix(control-center): open the phone sheet on the preset picker, and read permissions only when it opens'
  - 'fix(control-center): wait for permissions before saying nothing is overridden'
  - 'fix(marketplace): an agent package cannot ship what its agent may do'
  - 'fix(permissions): a new agent cannot bring wider permissions in its own folder'
  - 'fix(permissions): an action that shows what it would change always asks'
  - "fix(permissions): an arriving agent's folder settings never apply as written"
  - "fix(permissions): read an agent's own stop only through the gate reader"
  - 'fix(permissions): say when the new-agent record cannot be read, and retry it'
  - "fix(permissions): read no agent's own settings until the gate is wired"
  - 847dbbc
  - fcacf5a
  - fb6bdd0
  - 7c6f574
  - d0a661d
  - 26ec3c0
  - c35f6b1
  - 867f576
  - 0e9bef3
  - 3f039b4
  - 721fb5c
  - eda81c0
  - ff8ba8c
  - b6dc135
  - 629f51f
  - 2de41d6
  - 38294e1
  - 76db28f
---

### Added

- Pick Careful, Balanced or Full power in Settings → Permissions or the Control Center, and every area follows: rooms, tasks and schedules, other agents, messages, chat connections, tools and packages, DorkOS settings, safety limits, permissions, and reach and secrets. The picker shows how many changes you made on top, with a Reset (DOR-2278)
- Open any area to set its single actions one by one. An action whose card shows what it would change, like the model an agent runs on, always asks and never offers Always allow. An action that deletes or removes something asks you even when its area is Allowed, unless you set that one action yourself
- Give one agent its own Files & commands setting (Ask first, Act or Full autonomy). It applies to that agent's conversations, scheduled runs and room turns
- Let agents ask you to change a permission, or a setting only you may change, like remote access or login. Each one raises a card, never offers Always allow, and changes nothing until you say yes
- See and reset each agent's own permissions from the Control Center, in one tap
- Change permissions from a terminal with `dorkos permissions` and `dorkos agent permissions`

### Changed

- Choosing a preset now also sets Files & commands: Careful starts new conversations at Ask first, Balanced at Act, and Full power at Full autonomy, which asks you to confirm what it means the first time
- The agent profile's Tools & MCP page is now called MCP servers. What an agent may do is on its Permissions page

### Security

- A new agent can't bring wider permissions in its folder's settings file. When DorkOS adds an agent from a folder, however it gets there, it keeps only the settings that are stricter than your defaults, ignores the rest even if it can't rewrite the file, and says so in the history (DOR-2278)
- An agent package can no longer ship its own permissions. DorkOS refuses a package whose agent settings say what the agent may do, so an agent from the marketplace starts where your defaults say, and you decide the rest after it is installed (DOR-2278)

### Removed

- The per-agent limit ("observe" or "act") and the Agent context switches for tasks, messages, other agents and chat connections. Permission areas replace them

### Note for people upgrading

- If you are on Careful, agents now ask before they touch tasks and schedules, other agents, chat connections or rooms, where before some of those ran without asking
- An agent you had limited to "observe" now has every area Blocked. It can still post and react in conversations
- An Agent context switch you had turned off becomes that area Blocked for every agent. The history records each of these as an upgrade
- An agent you had switched a tool group on for (rooms, tasks, messages, other agents or chat connections) gets that area Allowed as its own setting, shown as an exception you can reset. It could already use those tools, so nothing it can do has widened
