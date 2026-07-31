---
covers:
  - 'feat(agents): an agent carries its own model and effort'
---

### Added

- Give one agent its own model and its own thinking level, instead of one answer for the whole machine. The agent that reviews your diffs can run on the big model while the one watching a room runs on the quick one. What an agent says about itself wins; anything it leaves unsaid falls back to your default for that runtime, and an agent that says nothing keeps working exactly as it did today. Room agents get the most out of this: a room reply now starts on whatever the agent it addressed asked for. **For now this lives in the agent's own `.dork/agent.json`** (`model` and `effort`) — the Agent Hub controls are coming.

### Changed

- OpenCode chats no longer carry a thinking level anywhere. OpenCode gives no way to ask for more or less thinking, so the setting was only ever handing you back what you typed — it is no longer saved, shown, or inherited from an agent. We would rather say it is not supported than pretend it does something.
