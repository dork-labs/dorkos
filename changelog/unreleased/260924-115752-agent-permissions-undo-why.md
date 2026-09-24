---
covers:
  - 'feat(permissions): Undo from the history, the last change behind every state, the reach of a default, and the Always allow suggestion'
  - 'feat(permissions): Undo, Why? and the reach preview in the app, and the suggestion on the request card'
  - 'test(permissions): phase 4 end to end, with docs'
---

### Added

- Undo any permission change from its history, in Settings → Permissions or on an agent's Permissions page. If something changed since, Undo asks before it sets it back, and a change that reached several agents undoes what still matches and tells you what it left alone (DOR-2278)
- Tap **Why?** next to any permission to see where it comes from and who last changed it, when, and where
- See how many agents a change reaches before you make it: every default row, single action, preset and Files & commands says "affects 33 agents"
- If you keep allowing the same thing, the request card offers to remember it: after three Allows in a week for the same agent and action, Always allow is highlighted once, and **Not now** turns that off for good
- Undo a change from a terminal with `dorkos permissions undo <id>`. `dorkos permissions history` now shows each change's id
