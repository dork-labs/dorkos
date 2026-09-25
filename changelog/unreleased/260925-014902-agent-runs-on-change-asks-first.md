---
covers:
  - "feat(server): an agent asks before changing an agent's runtime, model or effort (DOR-2328)"
  - "fix(server): a value can't draw a line of its own on the runtime/model card (DOR-2328)"
---

### Changed

- An agent now asks you before it changes what an agent runs on: its runtime, model or effort, for itself or any other agent. Every scheduled task that doesn't pick its own settings runs on those, so a change would reach work you already approved. The card shows each change as it is now and as it would be, for example **Model: claude-sonnet-4 → claude-opus-4**. If the agent's settings change again before you answer, you get a fresh card. Your own changes, from the **Runs on** menu or the agent's settings, still apply at once (DOR-2328)
