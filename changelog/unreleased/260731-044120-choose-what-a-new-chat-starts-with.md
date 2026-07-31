---
covers:
  - 'feat(settings): choose what a new chat starts with, and see who ignores it'
---

### Added

- **Settings → Runtimes now lets you choose what a new chat starts with**: which runtime, which model, and how hard it thinks. The runtime setting has been in DorkOS all along with nowhere to change it — this is its first screen. Model and effort are per runtime, because a model name only means something to the runtime that offers it. Change anything and DorkOS tells you the truth about when it takes effect: new chats start with it, chats already running keep what they have.
- **Under that card, every agent that runs on something else.** Agents that are simply set up differently are listed plainly; agents whose setup has stopped working — a runtime you have not connected, a model that is no longer offered, a thinking level on a runtime that has none — come first, in amber. Click any of them to land in that agent's own settings. When every agent is on your defaults, the list isn't there at all.
- **Model and thinking level joined the runtime dropdown in an agent's Config tab**, each wearing a small chip that says where the value came from: "server default · Opus", or "set here" when this agent picked its own. The chip is also the undo — click a "set here" chip and the one thing it offers is going back to your default. On a phone the rows open a sheet from the bottom with the same choice at the foot.
- Where a thinking level cannot work, DorkOS says so instead of hiding the row: "Not supported by OpenCode", or "This model doesn't take an effort setting". If one is already saved there, it says that too, and lets you clear it.

### Changed

- An agent set up to run on a runtime you have not connected — or to think harder on a runtime with no such setting — now shows up under **Needs attention** in the sidebar, next to the chats waiting on you. You should not have to open Settings to find out that an agent cannot start. A model that is no longer offered is a quieter problem and stays in the list under your defaults, where checking it does not cost a lookup per agent.
- The very first chat DorkBot starts during setup now runs on your default runtime. It used to always say Claude Code, even if you had chosen something else.
