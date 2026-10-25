---
covers:
  - "fix(server): apply an agent folder's own allow list once a person approves it (DOR-3039, DOR-3042)"
  - "fix(server): a Never ask chat can still use DorkOS's own safe-listed tools (DOR-3042)"
  - 'test(server): an agent can never grant itself its folder allow list (DOR-3039)'
  - 'fix(server): a folder allow list a person cannot read in full is never applied (DOR-3039)'
---

### Fixed

- An agent's own allow list (`permissions.allow` in its folder's `.claude/settings.json`) now applies under DorkOS. Before this, Claude Code ignored it in agent folders, so a chat set to **Never ask** refused even the commands the agent's folder allows, and said nothing about why. DorkOS now asks you once with an approval card that lists the agent's rules. After you allow it, the rules apply from the agent's next turn. If the agent adds rules, the list stops applying until you approve the change; the card shows what was added and removed. A list that only loses rules keeps applying without asking. Rules naming DorkOS's own tools, rules with a wildcard tool name, rules that allow a whole tool (like a bare `Bash`, which runs any command, or `Edit(./**)`), and file rules that reach outside the agent's folder are never applied. While a list applies, the agent's file tools also can't change its own settings, its other agents' settings, DorkOS's own data, or Claude Code's account files. A list too long to show in full on the card is never asked about, so you never approve a rule you couldn't see. Rules apply only to the agent's own turns in its own folder, never to teammate turns. While a list is waiting, a Never ask chat shows a line saying why it's refusing. A Never ask chat can also still read and post to its own rooms and use DorkOS's other built-in tools, which never ask in any mode.
