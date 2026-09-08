---
covers:
  - 'fix(harness): Codex SessionEnd and five more Copilot hook events project (DOR-1847)'
  - 'fix(harness): a plan says `native` only when the source is really there (DOR-1847)'
  - 'fix(harness): honest hooks, commands and Claude-only skills in the plan (DOR-1847)'
  - "fix(harness): a package's skills reach every agent that reads .agents/skills (DOR-1847)"
  - 'fix(harness): the no-artifact rule is universal, and a manifest entry is read where it points (DOR-1847)'
  - 'fix(rooms,cli): a room worktree hides the package links, and the summary stops implying Codex is on (DOR-1880, DOR-1847)'
  - 'fix(harness): a redundant claudeOnlySkills entry says so on the first pass (DOR-1847)'
---

### Fixed

- If you use Cursor, Gemini CLI or GitHub Copilot, `dorkos harness sync` no longer tells you your skills were left behind. All three read the shared `.agents/skills` folder, so they had your skills the whole time — the report was wrong, not your setup (DOR-1847)
- A package you install now puts its skills in that shared folder no matter which agents you have turned on. Before, only turning Codex on put them there, so a project running just OpenCode or just Cursor got none of them (DOR-1847)
- More of your Claude Code hooks travel to the other agents. Codex now gets the "session ended" hook, and Copilot gets five more — including compaction, permission requests and notifications — instead of being told they do not exist (DOR-1847)
- `dorkos harness sync` no longer claims an agent is reading a file you do not have. With no `AGENTS.md`, no hooks and no commands folder, it says so plainly rather than listing them as working (DOR-1847)
- Skills you deliberately keep for Claude Code only now show up in the report as kept, with a line per agent that does not get them. They used to be missing from it entirely (DOR-1847)
- When a command cannot travel to an agent, the reason now names that agent's own command folder — `.cursor/commands`, `.gemini/commands`, `.github/prompts` — instead of saying it has none (DOR-1847)
- A project with no slash commands and no hooks is no longer told, five times over, that its commands were left behind. If you never wrote one, `dorkos harness sync` says nothing about them (DOR-1847)
- A skill you keep only for Claude Code is now looked for where your settings file says it is, instead of only in the usual folder — so a skill that is really there is no longer reported as a leftover entry (DOR-1847)
- If you list a skill as Claude-Code-only when it is really in the shared folder, you are told the first time you check, on a fresh copy of the project — not only after a sync has already run (DOR-1847)
- Room work folders stay clean when the room's project has a package installed. The links DorkOS makes for it no longer show up as your unsaved changes, which used to stop the folder being tidied up or merged (DOR-1880)
