---
covers:
  - "fix(server): MCP task edits clamp an approved bypass task's power, closing the resync window (security)"
---

### Security

- An agent can no longer briefly run a scheduled task at full power by editing it through the tool API. When a task is allowed to run without asking and an agent changes what it does — its instructions, its schedule, or its name — DorkOS now puts the normal approval prompts back the instant the edit lands, instead of leaving a short gap where the next run could fire at full power. Editing a task that only toggles it on or off, or renames nothing, is untouched. This closes the same escape on the tool API that was already closed for edits made in the app.
