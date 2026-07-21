### Added

- Build a sidebar group that fills itself in: pick "Active now" or "By runtime · Codex" from the "+" menu, or write your own rule (runtime, namespace, status, how recently active, folder path), and DorkOS keeps the group's members current on its own as agents start work, go idle, or switch projects. Only shows up once you're running 8+ agents or 2+ runtimes, so a small fleet's sidebar looks exactly like it did before. (DOR-338)
- A smart group always tells you what it's showing: a plain-English rule summary in its menu, and an honest "No agents match these rules" instead of vanishing when nothing qualifies. You can't drag an agent into one, dropping on it shows a reminder to edit the rule instead, and matching agents still show up in their usual group too. (DOR-338)
- Change your mind any time: "Edit rules" reopens the same rule form, and "Convert to manual group" freezes today's members into a regular group you manage by hand. (DOR-338)
