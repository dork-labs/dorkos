---
covers:
  - 'fix(server): agents cannot undo a limit you turned down (DOR-1497)'
---

### Security

- Settings you turn **down** to give your machine room can no longer be turned back up by an agent. Nine of them were missing that protection: whether your Claude Code chats keep an agent awake between messages (which can cost about a gigabyte each), how many scheduled runs may go at once, how large an upload may be and how many files it may carry, whether DorkOS updates the agent files inside your projects on its own, and which four sets of DorkOS tools your agents are told about. An agent asking to change any of those now gets a plain refusal and nothing is written.
- DorkOS already refused to undo choices like these when it had to rebuild your settings file after a problem — it just did not refuse an agent that asked on purpose. Now the two rules match, and a check in the build keeps them matching.
- You still change every one of them yourself, in the same place as before. Warm agents and how many scheduled runs go at once are in the Control Center (`⌘⇧L`, or `Ctrl+Shift+L`); the four tool switches are in Settings → Tools. The upload limits and the project-file updates have no switch yet, so `dorkos config set` is the way there — and now the choice you make there sticks.
