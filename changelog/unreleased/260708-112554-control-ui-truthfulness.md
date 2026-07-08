### Fixed

- Agents controlling the UI now get honest answers: `get_ui_state` reflects the state your client last reported plus the commands the agent issued this turn, instead of stale pre-turn state. Its description no longer over-promises a live read.
- The `control_ui` tool description now tells agents the truth about delivery: commands only take visible effect when an interactive client is attached (headless and scheduled runs accept them but show nothing), and canvas content pushes may be deferred while you are actively editing the canvas — a success result means "accepted", not "displayed".
- `control_ui` / `get_ui_state` invoked without an attached session now return a clear MCP error instead of a fake success or fabricated default UI state.
- Removed the non-existent `"mesh"` panel from the `control_ui` docs and added the real `picker` panel to the reported UI state, so the tool contract matches what the UI actually supports.
- The client now omits the UI-state snapshot from a message when it hasn't changed since the last send, so identical snapshots stop accumulating in the transcript.
