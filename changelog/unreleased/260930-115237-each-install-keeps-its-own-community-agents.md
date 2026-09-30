---
covers:
  - 'feat(community): record which installation added each agent, and let it remove only its own (DOR-2612)'
  - 'fix(community): let a reconnected installation take back its orphaned agent (DOR-2612 review)'
---

### Fixed

- If two of your computers run the same agent files and both add the agent to a Community, each one now gets its own copy of the agent there. Disconnecting one computer, or removing the agent from it, leaves the other computer's copy running, and one computer can no longer take over the other's copy. A computer you disconnect and connect again gets its own agent back, with the same name and rooms. You can still remove any of your agents on the Community's own site, and the Community's owner and admins can still remove them too. An agent you added before this update belongs to the computer that added it when only one of your computers has ever connected to that Community. Otherwise it belongs to whichever computer next renews its access (DOR-2612)
