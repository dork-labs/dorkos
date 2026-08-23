---
covers:
  - "feat(client,server,shared): Control Center — see and change your agents' power at a glance (DOR-1431)"
---

### Added

- A **Control Center** to see and change your agents' power at a glance. Tap the ⚡ in the top bar (or press ⌘⇧L, or search "Control Center") and one panel opens: how much new sessions may do before they ask, whether your agents can talk across projects, whether "stop asking about this" sticks, whether agents stay warm between messages, and how many scheduled tasks run at once. Setting where new sessions start applies to new sessions — conversations already running keep what they have.
- The Control Center's **Exceptions** list shows anything that runs at a different power than your dial: a runtime with its own default, a live session, a task, or an integration. Each line takes you straight to where you can change it. A tidy setup shows a calm "everything follows your dial" instead.

### Changed

- New scheduled tasks and new integrations now start at **your own power level** instead of always "accept edits." If you set your default to full power, you no longer re-pick it every time; if you kept "ask first," nothing is quietly turned up. You still confirm once when you point one at full power, since no one is watching it run.
- When an agent is set to **ask first**, its permission popover now shows a quiet "Limited — unlock" pointing at the Control Center, so opening things up is one step away. It is a gentle nudge, never a warning — asking first is a fine choice.
