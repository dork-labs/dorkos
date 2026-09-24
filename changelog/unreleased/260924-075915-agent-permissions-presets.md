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
---

### Added

- Pick Careful, Balanced or Full power in Settings → Permissions or the Control Center, and every area follows: rooms, tasks and schedules, other agents, messages, chat connections, tools and packages, DorkOS settings, safety limits, permissions, and reach and secrets. The picker shows how many changes you made on top, with a Reset (DOR-2278)
- Open any area to set its single actions one by one. An action that deletes or removes something asks you even when its area is Allowed, unless you set that one action yourself
- Give one agent its own Files & commands setting (Ask first, Act or Full autonomy). It applies to that agent's conversations, scheduled runs and room turns
- Let agents ask you to change a permission, or a setting only you may change, like remote access or login. Each one raises a card, never offers Always allow, and changes nothing until you say yes
- See and reset each agent's own permissions from the Control Center, in one tap
- Change permissions from a terminal with `dorkos permissions` and `dorkos agent permissions`

### Changed

- Choosing a preset now also sets Files & commands: Careful starts new conversations at Ask first, Balanced at Act, and Full power at Full autonomy, which asks you to confirm what it means the first time
- The agent profile's Tools & MCP page is now called MCP servers. What an agent may do is on its Permissions page

### Removed

- The per-agent limit ("observe" or "act") and the Agent context switches for tasks, messages, other agents and chat connections. Permission areas replace them

### Note for people upgrading

- If you are on Careful, agents now ask before they touch tasks and schedules, other agents, chat connections or rooms, where before some of those ran without asking
- An agent you had limited to "observe" now has every area Blocked. It can still post and react in conversations
- An Agent context switch you had turned off becomes that area Blocked for every agent. The history records each of these as an upgrade
- An agent you had switched a tool group on for (rooms, tasks, messages, other agents or chat connections) gets that area Allowed as its own setting, shown as an exception you can reset. It could already use those tools, so nothing it can do has widened
