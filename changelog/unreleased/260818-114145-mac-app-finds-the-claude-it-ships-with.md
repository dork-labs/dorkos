---
covers:
  - 'fix(server,client): the Mac app finds the Claude Code it ships with; Install Claude works; Codex shows its real status (DOR-1334)'
---

### Fixed

- The Mac app no longer says "Claude Code CLI: missing" when it ships with Claude Code. It was looking for the copy inside its own app bundle in a place it could never run it, and it never looked at the one the app hands it. Both checks now walk the same list of places as the agent itself, so what the setup screen says and what your sessions actually run are the same thing (DOR-1334)
- Codex now shows up with an honest status even when the Codex tool is not installed. It used to vanish from the setup screen entirely, leaving a card with nothing to say. If you start a Codex chat without it, you get a plain sentence telling you what to install (DOR-1334)
- "Install Claude" now installs Claude. The button was there but had nothing behind it, so clicking it looked like nothing happening. If a one-click install is not available for something, you get a sentence saying so and the command to run yourself (DOR-1334)
- When a check reports something missing, the server log now says why — which tool, where it looked, and what went wrong — instead of staying silent (DOR-1334)
