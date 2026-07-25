---
covers:
  - "feat(agents): every runtime's agent knows what it is and what it can do (DOR-428)"
  - 'fix(agents): stop the agent-facing prose overclaiming what a shell can reach (DOR-428)'
  - 'fix(agents): close the last copies of the capability overclaim (DOR-428)'
---

### Added

- Your agents in Codex and OpenCode sessions now know who they are and what they can do. They get the same DorkOS briefing Claude Code agents get: their own name and personality, their safety rules, and the commands for listing and running DorkOS actions. Codex agents also get an identity, so what they change shows up under their name in Activity (DOR-428)
- Your own agent in a Claude Code session can now ask a running DorkOS what is going on: which sessions are open, which agents exist, which skills are installed, and what it is allowed to do. Outside tools could already ask; your agent could not. Codex and OpenCode sessions do not have this yet (DOR-428)

### Changed

- The built-in "Operating DorkOS" skills now teach the real rules: what an agent can read freely, what it can change, and what needs your approval first, including exactly how it asks and waits for you. They also cover `dorkos call`, the one command that runs any DorkOS capability by name from any agent (DOR-428)

### Fixed

- `list_capabilities` no longer tells an agent it is seeing everything DorkOS can do. It lists the actions you can run by name and says where the rest live, so an agent stops concluding it cannot do things it can (DOR-428)
- The built-in skills no longer teach an out-of-date settings example, so an agent asking to change a setting for you sends something DorkOS actually accepts (DOR-428)
- Agents are told which commands actually exist. Before, an agent in a Codex or OpenCode session could go looking for a command that was never built, or tell you to check the activity feed for something that was never written there. Now it says plainly when a job has to be done from the DorkOS app instead (DOR-428)
